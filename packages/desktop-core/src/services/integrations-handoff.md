# Integrations port: handoff

Worker scope: AI CLI providers, Telegram, signed webhooks/outbox, license, diagnostics, backup,
export, workspace actions, data lifecycle. Rust is the oracle (`crates/ai-bridge`, `crates/notify`,
`crates/core`). No existing file was edited; everything is new.

## Composition (coordinator)

```ts
import { INTEGRATION_HANDLERS, startIntegrations, shutdownIntegrations } from "./services/integrations";
const handlers = { ...DEFAULT_HANDLERS, ...INTEGRATION_HANDLERS, ...others };
// after DesktopRuntime.start():  startIntegrations(runtime.context, { hooks, log })
// in DesktopRuntime.shutdown():  await shutdownIntegrations(runtime.context)   // before store.close()
```

`src/index.ts` is not touched. Export from `./services/integrations` only (the sub-modules export
generic helper names such as `asString`).

Per-area tables: `SETTINGS_HANDLERS`, `CHANNEL_HANDLERS`, `SYSTEM_HANDLERS`, `EXPORT_HANDLERS`;
all 18 ids in `INTEGRATION_COMMAND_IDS`.

## Handlers (18)

lead_export, settings_get, settings_set, ai_probe, ai_set_provider, telegram_set_token,
telegram_test, channel_list, channel_remove, webhook_add, license_get, license_set, ai_usage_get,
diagnostic_bundle_create, data_backup, workspace_action, data_purge, data_delete_all.

## Hooks for PipelineService (all take the handlers' `RuntimeContext`)

Notifications:

```ts
routeLeadNotifications(ctx, input: RouteLeadNotificationsInput): Promise<void>
//  input = { lead: LeadRecord, post: PostRecord, sourceName, authorName, radarId, radarName,
//            radarStatus, radarNotify: NotifyConfig, radarVersion: RadarVersionRecord,
//            isSilentOrPreview, repostAfter72h, now }
//  Call right after leads.createLead (Rust route_lead_notifications). Throws CoreError(notify_error)
//  where Rust returned Err (invalid permalink / callback data).
flushDigestForRadar(ctx, radarId): void          // body of the `flush_digest` job
runNotifyLeadJob(ctx): Promise<void>             // body of the `notify_lead` job
enqueueDigestLead / markRadarFloodAutoDigest / getFloodAutoDigestRadars / setEvalFeedbackLabel
queueSystemIncidentAlert(ctx, incident: SystemIncidentKind, resolved, now): number
startIntegrationWorkers(ctx, { log? }): { wakeOutbox(), stop() }   // outbox + telegram poller loops
processDueOutboxBatch(ctx) / pollTelegramOnce(ctx)                  // single ticks (tests, jobs)
```

AI:

```ts
getAiBridge(ctx): AiBridge
runAiTask(ctx, req: AiRequest, { radarVersionId?, itemCount? }): Promise<TaskResult<unknown>>
//  in-flight tracking + schema validation + one invalid-output retry + ai_calls rows + health update;
//  throws CoreError(ai_error). Task prompts/validators (judge/suggest/compile) stay in the pipeline port.
noteAiFailure(ctx, err: AiError, now) / noteAiSuccess(ctx, now)
aiBackoffUntil(ctx, now): number | null          // honour before a batch (rate-limit window)
aiDailyBudget(ctx, now): { cap, used, remaining }
```

`IntegrationHooks` (inject via `startIntegrations(ctx, { hooks })` / `configureIntegrations`),
every hook optional, default = documented no-op, never a fabricated success:
`ipcSnapshot` (health: extension/session/crawl state), `resumeCrawl` (Telegram /resume),
`bumpAndPushConfig`, `wakeJobs`, `loadLeadDto` (for `lead:updated`), `onNegativeFeedback`,
`onDataDeleted`, `onLaunchAtLoginChanged`, `radar.{get,update}` (needed by
`workspace_action("rollback")`; without it the action answers `not_implemented`).

## Intentional deviations from Rust

- Webhook POST does not follow redirects (a 3xx is a failed attempt); Rust follows them and would
  re-send the signed body to an unconfigured host.
- `webhook_add` deletes the new channel if storing its secret fails (Rust leaves it).
- Windows CLI lookup prefers `.exe/.cmd/.bat` over the extension-less npm shim; `.cmd` launches use
  the Rust-std batch escaping and refuse newline arguments.
- CLI output is capped at 16 MiB per stream.
- Diagnostic ZIP and log entries are written 0600.
- `chrome_connect`, `health_get`, `crawl_run_list` are not part of this port (`computeHealthStatus`
  is exported for the owner of `health_get`).

## Not ported / blockers

- `DEALSONAR_MOCK_AI` heuristic provider (mock-only); inject a provider with
  `configureIntegrations(ctx, { aiProvider })` instead.
- AI task layer (`prompts.rs`, `schema/semantic.rs`, batch bisection, eval) belongs to the pipeline.
- Health-monitor loop (`workers/health.rs`: incident detection, daily maintenance) and the jobs
  worker must call the exported entry points above.
- Windows: CLI subprocess tests are skipped on win32 (POSIX fake launchers); only the batch-argument
  encoder is covered there.

## Verification (not run by the worker: no installs / shell)

```
pnpm -C packages/desktop-core typecheck
pnpm -C packages/desktop-core test -- integrations
```
