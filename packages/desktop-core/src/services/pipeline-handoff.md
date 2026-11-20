# Pipeline worker handoff (rules engine, pipeline, scheduler, jobs, 10 handlers)

Base: `migration/electron-backend` @ c172a03. Rust (`crates/rules`, `crates/core`) is the oracle.
**Nothing here has been compiled or run**: the worker had no permitted shell. The coordinator must run
typecheck + tests (see "Verification").

## Handlers (`PIPELINE_HANDLERS`, `services/pipeline-handlers.ts`)

`source_crawl_now`, `radar_suggest_fields`, `radar_set_status`, `radar_preview_start`, `radar_preview_get`,
`radar_preview_cancel`, `ruleset_compile_now`, `health_get`, `crawl_run_list`, `backend:toggle_crawl_paused`.
Compose: `{ ...DEFAULT_HANDLERS, ...PIPELINE_HANDLERS }`. Handlers resolve `PipelineService.for(ctx)`
(memoized per `RuntimeContext`), so no change to `runtime.ts` is needed.

## PipelineService (`services/pipeline.ts`)

```ts
const pipeline = PipelineService.for(ctx, { hooks, config?, desktopVersion? });
pipeline.configure(hooks);              // partial merge, any time
pipeline.start();                       // jobs loop (250 ms + wake), health (60 s), config re-push (300 s), daily maintenance
await pipeline.stop();                  // shutdown flag, abort previews, wait <=10 s for in-flight AI, stop loops, detach peers

// IPC peers (protocol-handshake worker): framing/parsing stays there, bodies are consumed here.
const peer = pipeline.attachPeer({ send(env) { /* queue to extension */ } }, { desktopVersion });
peer.consume(envelope);                 // v2 envelope {v,id,ts,reply_to,type,payload}; never throws, replies/errors via send()
peer.detach();                          // on close; idempotent

pipeline.ingestRawPost(sourceId, rawPost);   // T0-T4 sync (golden tests, MCP/agent paths)
pipeline.tickJobs();                         // one jobs pass (tests)
pipeline.rulesetSaveUser(radarId, versionId, dtoBody)  // ported, not registered as handler (not in this worker's list)
pipeline.radarDto(rw, now)                   // `Radar` DTO as in radar_get(...).radar
```

Consumed message types: `hello`, `posts.push`, `crawl.report`, `sources.discovered`, `session.status`, `ping`.
Emitted: `hello.ok`, `config.update`, `crawl.pause`, `crawl.resume`, `crawl.request`, `ack`, `pong`, `error`.
Message-id dedup cache (4096) is kept, so replayed ids get their original ack.

## Hook signatures (`pipeline/types.ts`, all optional)

| Hook | Contract | When missing |
|---|---|---|
| `ai: AiHooks` | `providerId()`, `judgeExtractAll(radar, posts, {max_posts, preview})`, `suggestFields(input)`, `compileRules(input)`; throw `AiHookError(kind, msg, retryAfterMs?)` | AI features throw `ai_error` "AI bridge chưa được cấu hình"; evaluate_batch jobs fail and retry per the Rust backoff table |
| `notify: NotificationHooks` | `routeLead(input)` (policy, quiet hours, digest/flood, outbox rows, `notify_lead` job), `runJob("notify_lead"\|"flush_digest", payload)`, optional `queueSystemIncident(incident, resolved, now)` | lead still created; routing skipped and logged; `notify_lead`/`flush_digest` jobs FAIL (never marked done) |
| `license: LicenseHooks` | `limits(now)`, optional `enforcePlanLimits(now)` | Personal plan limits |
| `templates: TemplateHooks` | `get(id)` for `suggest_fields.closest_template` | `null` |
| `now`, `log` | clock / logger | `Date.now`, silent |

OS notification fallback (no Telegram, <=6 h old, radar active, not silent/preview) is done by the pipeline via
`ctx.notifyOs({lead_id, radar_name, summary})`.

## Files

`src/rules/`: `normalize, types, prefilter, postfilter, engine, gate, seed, index`, `extractors/{phone,money,area,number,date-vi,enum-kw,regex-ext}`,
`extractors/gazetteer/{index,entry,data-provinces-hanoi,data-cities}`.
`src/pipeline/`: `types, runtime, scheduler, dto, shadow, notify, evaluate, finalize, ai-batch, ingest, preview, rulesets, peers, jobs, index`.
`src/services/`: `pipeline.ts`, `pipeline-handlers.ts`, this file.
`test/`: `pipeline-rules.test.ts` (Rust golden cases), `pipeline-service.test.ts` (real in-memory SQLite).

Package index (coordinator): add
`export * from "./services/pipeline"; export * from "./services/pipeline-handlers"; export * as rules from "./rules"; export * as pipeline from "./pipeline";`
(namespaces avoid `PeerSignals`/`LabeledSample` name clashes with the store exports).

## Known divergences / blockers

1. `detect_lang`: Rust uses `whatlang`; TS uses a script + stop-word heuristic (same codes, same `und` < 20 chars threshold). `posts.lang` and DSL `lang_in` can differ on mixed/other-Latin text. Needs a decision (dependency such as `franc-min` or accept).
2. `validate_ruleset` latency budget: Rust 1 ms median on a 5,000-char post; TS default 25 ms (`validateRuleset(body, { maxMedianMs })`). Needs measurement on all four OS CI runners.
3. Regex: Rust is linear-time; JS backtracks. `check_regex_pattern_safety` is ported and additionally rejects look-around, backrefs and repeated groups containing alternation (`(a|a)*`) so patterns accepted by Rust but rejected here are possible; the reverse is not.
4. Offsets are UTF-16 code units (Rust: UTF-8 bytes); `text_norm.slice(start,end) === raw` holds. JSON number formatting differs only textually (`50` vs Rust `50.0` for f64 range values).
5. `ruleset_compile_now`: Rust leaves an accidentally claimed *other* job `running`; TS executes it. Deliberate fix.
6. `OsNotificationPayload` on the wire has no group/permalink (Rust hook had them).
7. Not in this worker: notification delivery/outbox/Telegram poller, AI bridge providers, license verification, `radar_list/get/create/update`, `ruleset_list/save_user` handler registration, protocol framing/handshake.
8. Health incidents (`queueSystemIncident`) only fire when a notify hook implements it.

## Verification (coordinator)

```
pnpm --filter @dealsonar/desktop-core typecheck
pnpm --filter @dealsonar/desktop-core test -- pipeline-rules pipeline-service
```
First failures are most likely in: gazetteer/data typos (transcribed by hand from `data.rs`), `lang` heuristic, float formatting in tests, and
store API assumptions in `pipeline-service.test.ts`. Then run the 4-OS gate on the backend bundle.
