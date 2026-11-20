// Port of the message-handling half of crates/core/src/ipc_server.rs (`handle_body`,
// `handle_session_status`, `push_crawl_request`, source upserts). Framing, protocol parsing and the
// `hello` handshake transport stay with the protocol worker (native-host DesktopIpcServer); it
// parses each frame into a v2 envelope and calls `PipelinePeerHandle.consume`.

import { CoreError } from "../backend/wire";
import type { DiscoveredSourceInput, SourceRecord } from "../store/sources";
import { ingestRawPost, wasInserted, type RawPost } from "./ingest";
import { crawlRunToDto, makeEnvelope, PLATFORM_FACEBOOK, type CrawlRuntimeStatus, type PipelineRuntime, type ProtocolEnvelope } from "./runtime";
import type { CrawlPauseReason, FacebookSessionState } from "./types";

/** Desktop version reported in `hello.ok`. */
export interface PeerOptions {
  desktopVersion: string;
}

export interface PipelinePeerTransport {
  /** Queue an envelope for the extension. Must not block; errors are treated as a dead stream. */
  send(envelope: ProtocolEnvelope): void;
}

export interface PipelinePeerHandle {
  readonly connId: number;
  /** Handle one parsed extension -> desktop envelope. Never throws; failures become `error` envelopes. */
  consume(envelope: ProtocolEnvelope): void;
  /** Remove the peer and refresh health. Idempotent. */
  detach(): void;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw CoreError.validation(`${what} must be an object`);
  return v;
}
function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== "string") throw CoreError.validation(`missing or invalid '${key}'`);
  return v;
}
function int(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw CoreError.validation(`missing or invalid '${key}'`);
  return v;
}
interface SourceRefWire {
  platform: string;
  kind: string;
  external_id: string;
}
function sourceRef(v: unknown): SourceRefWire {
  const o = obj(v, "source_ref");
  return { platform: str(o, "platform"), kind: str(o, "kind"), external_id: str(o, "external_id") };
}

const CRAWL_STATUSES = ["ok", "empty", "blocked", "error"];
const SESSION_STATES = ["ok", "logged_out", "checkpoint", "rate_limited", "unknown"];

export function ensureSourceExists(rt: PipelineRuntime, ref: SourceRefWire, profileId: string | null, now: number): SourceRecord {
  const existing = rt.store.sources.getByExternalId(ref.platform, ref.external_id);
  if (existing) return existing;
  rt.store.sources.upsertDiscovered(
    [
      {
        platform: ref.platform,
        kind: ref.kind,
        external_id: ref.external_id,
        name: `Group ${ref.external_id}`,
        url: `https://www.facebook.com/groups/${ref.external_id}`,
        privacy: null,
        member_count: null,
      },
    ],
    null,
    profileId,
    now,
  );
  const created = rt.store.sources.getByExternalId(ref.platform, ref.external_id);
  if (!created) throw CoreError.internal(`failed to create placeholder source for ${ref.external_id}`);
  return created;
}

function sourceInfoToInput(s: Obj): DiscoveredSourceInput {
  const privacy = s.privacy;
  return {
    platform: str(s, "platform"),
    kind: str(s, "kind"),
    external_id: str(s, "external_id"),
    name: str(s, "name"),
    url: str(s, "url"),
    privacy: privacy === "public" || privacy === "private" ? privacy : null,
    member_count: typeof s.member_count === "number" ? s.member_count : null,
  };
}

function upsertSourcesRespectingPlan(
  rt: PipelineRuntime,
  sources: unknown[],
  follow: boolean | null,
  profileId: string | null,
  now: number,
): number {
  if (sources.length === 0) return 0;
  const infos = sources.map((s) => obj(s, "source"));
  if (follow !== true) {
    const res = rt.store.sources.upsertDiscovered(infos.map(sourceInfoToInput), follow, profileId, now);
    return res.inserted + res.updated;
  }
  const maxGroups = rt.licenseLimits(now).max_followed_groups;
  let remaining = Math.max(maxGroups - Math.max(rt.store.sources.countFollowed(), 0), 0);
  const allowed: DiscoveredSourceInput[] = [];
  const capped: DiscoveredSourceInput[] = [];
  for (const info of infos) {
    const input = sourceInfoToInput(info);
    const already = rt.store.sources.getByExternalId(input.platform ?? PLATFORM_FACEBOOK, input.external_id)?.followed === true;
    if (already) allowed.push(input);
    else if (remaining > 0) {
      remaining -= 1;
      allowed.push(input);
    } else capped.push(input);
  }
  let total = 0;
  if (allowed.length > 0) {
    const r = rt.store.sources.upsertDiscovered(allowed, true, profileId, now);
    total += r.inserted + r.updated;
  }
  if (capped.length > 0) {
    const r = rt.store.sources.upsertDiscovered(capped, false, profileId, now);
    total += r.inserted + r.updated;
  }
  return total;
}

function handleSessionStatus(rt: PipelineRuntime, state: string, now: number): void {
  if (state === "ok") {
    const wasCheckpoint = rt.facebookSession === "checkpoint" || rt.crawlPauseReason === "checkpoint_awaiting_resume";
    rt.facebookSession = "ok";
    if (wasCheckpoint) {
      // After a checkpoint clears, stay paused until the user explicitly resumes (`02-extension.md §7`).
      rt.crawlPaused = true;
      rt.crawlPauseReason = "checkpoint_awaiting_resume";
    } else if (rt.crawlPauseReason === "logged_out" || rt.crawlPauseReason === "rate_limited") {
      rt.crawlPaused = false;
      rt.crawlPauseReason = null;
    }
    const wasAlerted = rt.incidents.fbSessionAlerted;
    rt.incidents.fbSessionAlerted = false;
    if (wasAlerted) rt.queueSystemIncident({ kind: "facebook_session_issue" }, true, now);
    rt.emitHealthSoon(now);
    return;
  }

  let mapped: FacebookSessionState;
  let pauseReason: CrawlPauseReason;
  switch (state) {
    case "checkpoint":
      mapped = "checkpoint";
      pauseReason = "checkpoint_awaiting_resume";
      break;
    case "rate_limited":
      mapped = "rate_limited";
      pauseReason = "rate_limited";
      break;
    default: // logged_out | unknown
      mapped = "logged_out";
      pauseReason = "logged_out";
  }
  rt.facebookSession = mapped;
  rt.crawlPaused = true;
  rt.crawlPauseReason = pauseReason;
  rt.sendToProfile(null, makeEnvelope("crawl.pause", { until: null, reason: `facebook_${state}` }, null, now));

  if (!rt.incidents.fbSessionAlerted) {
    rt.incidents.fbSessionAlerted = true;
    rt.queueSystemIncident({ kind: "facebook_session_issue" }, false, now);
  }
  rt.emitHealthSoon(now);
}

/** Push an on-demand `crawl.request` to the source's owning profile (any profile when it is offline). */
export function pushCrawlRequest(
  rt: PipelineRuntime,
  source: SourceRecord,
  reason: "manual" | "preview" | "scheduled" | "passive",
  maxPosts: number,
  requestId: string,
): number {
  const env = makeEnvelope(
    "crawl.request",
    {
      request_id: requestId,
      source_ref: { platform: source.platform, kind: source.kind, external_id: source.external_id },
      reason,
      max_posts: maxPosts,
    },
    null,
    rt.now(),
  );
  const sent = rt.sendToProfile(source.profile_id, env);
  if (sent === 0 && source.profile_id !== null) return rt.sendToProfile(null, env);
  return sent;
}

/** Register a relay connection and return its consume/detach handle. */
export function attachPeer(rt: PipelineRuntime, transport: PipelinePeerTransport, options: PeerOptions): PipelinePeerHandle {
  const connId = rt.allocConnId();
  let boundProfileId: string | null = null;
  let detached = false;

  const send = (env: ProtocolEnvelope): void => {
    try {
      transport.send(env);
    } catch {
      // A dead transport is reaped by `detach` from the transport's close handler.
    }
  };
  const reply = (replyTo: string, type: string, payload: Record<string, unknown>): void =>
    send(makeEnvelope(type, payload, replyTo, rt.now()));

  const cachedAck = (msgId: string): boolean => {
    const hit = rt.dedup.get(msgId);
    if (!hit) return false;
    reply(msgId, "ack", { accepted: hit[0], duplicates: hit[1] });
    return true;
  };

  const handleBody = (msg: ProtocolEnvelope): void => {
    const now = rt.now();
    const msgId = msg.id;
    const p = obj(msg.payload ?? {}, "payload");
    switch (msg.type) {
      case "hello": {
        const profileId = str(p, "profile_id");
        const extConfigRev = int(p, "config_rev");
        boundProfileId = profileId;
        rt.lastDisconnectedAt = null;
        rt.peers.set(connId, {
          connId,
          profileId,
          extVersion: str(p, "ext_version"),
          browser: str(p, "browser"),
          connectedAt: now,
          crawlRuntime: null,
          send,
        });
        const currentRev = rt.configRev;
        const wasAlerted = rt.incidents.extDisconnectedAlerted;
        rt.incidents.extDisconnectedAlerted = false;
        if (wasAlerted) rt.queueSystemIncident({ kind: "extension_disconnected" }, true, now);

        reply(msgId, "hello.ok", { desktop_version: options.desktopVersion, config_rev: currentRev });
        if (extConfigRev < currentRev) {
          const [, cfg] = rt.buildConfigUpdateForProfile(profileId);
          send(cfg);
        }
        if (rt.crawlPaused) {
          const reason = rt.crawlPauseReason ?? "paused";
          send(makeEnvelope("crawl.pause", { until: null, reason }, null, now));
        }
        rt.emitHealthSoon(now);
        return;
      }
      case "posts.push": {
        if (cachedAck(msgId)) return;
        const ref = sourceRef(p.source_ref);
        if (!Array.isArray(p.posts)) throw CoreError.validation("missing or invalid 'posts'");
        const primary = ensureSourceExists(rt, ref, boundProfileId, now);
        let accepted = 0;
        let duplicates = 0;
        for (const rawPost of p.posts as RawPost[]) {
          const postSource =
            rawPost.source_external_id === primary.external_id && rawPost.platform === primary.platform
              ? primary
              : ensureSourceExists(rt, { platform: rawPost.platform, kind: ref.kind, external_id: rawPost.source_external_id }, boundProfileId, now);
          const outcome = ingestRawPost(rt, postSource, rawPost, now);
          if (wasInserted(outcome)) accepted += 1;
          else duplicates += 1;
        }
        rt.dedup.insert(msgId, [accepted, duplicates]);
        reply(msgId, "ack", { accepted, duplicates });
        return;
      }
      case "crawl.report": {
        if (cachedAck(msgId)) return;
        const ref = sourceRef(p.source_ref);
        const status = str(p, "status");
        if (!CRAWL_STATUSES.includes(status)) throw CoreError.validation("invalid 'status'");
        const source = ensureSourceExists(rt, ref, boundProfileId, now);
        const postsSeen = int(p, "posts_seen");
        const error = typeof p.error === "string" ? p.error : null;
        const run = rt.store.sources.recordCrawlRun({
          id: str(p, "run_id"),
          source_id: source.id,
          reason: str(p, "reason"),
          status,
          started_at: int(p, "started_at"),
          ended_at: int(p, "ended_at"),
          posts_seen: postsSeen,
          posts_new: int(p, "posts_new"),
          page_loads: int(p, "page_loads"),
          strategy: typeof p.strategy === "string" ? p.strategy : null,
          error,
        });

        if (status === "ok" || status === "empty") {
          rt.store.sources.setState(source.id, "ok");
          rt.setSourceLastError(source.id, null);
        } else if (status === "blocked") {
          rt.store.sources.setState(source.id, "inaccessible");
          rt.setSourceLastError(source.id, error ?? "group blocked or inaccessible");
        } else {
          rt.store.sources.setState(source.id, "error");
          rt.setSourceLastError(source.id, error ?? "crawl failed");
        }

        // 3 consecutive `empty` crawls across distinct sources while the session is ok => extractor broken.
        let alertBroken = false;
        let alertRecovered = false;
        if (status === "empty" && rt.facebookSession === "ok") {
          if (!rt.consecutiveEmptySources.includes(source.id)) rt.consecutiveEmptySources.push(source.id);
          if (rt.consecutiveEmptySources.length >= 3) {
            rt.extractorBroken = true;
            alertBroken = true;
          }
        } else if (status === "ok" && postsSeen > 0) {
          rt.consecutiveEmptySources = [];
          if (rt.extractorBroken) {
            rt.extractorBroken = false;
            alertRecovered = true;
          }
        }
        if (alertBroken) {
          if (!rt.incidents.extractorBrokenAlerted) {
            rt.incidents.extractorBrokenAlerted = true;
            rt.queueSystemIncident({ kind: "extractor_broken" }, false, now);
          }
        } else if (alertRecovered && rt.incidents.extractorBrokenAlerted) {
          rt.incidents.extractorBrokenAlerted = false;
          rt.queueSystemIncident({ kind: "extractor_broken" }, true, now);
        }

        rt.emit("crawl:finished", crawlRunToDto(run));
        rt.emitHealthSoon(now);
        rt.dedup.insert(msgId, [1, 0]);
        reply(msgId, "ack", { accepted: 1, duplicates: 0 });
        return;
      }
      case "sources.discovered": {
        if (cachedAck(msgId)) return;
        if (!Array.isArray(p.sources)) throw CoreError.validation("missing or invalid 'sources'");
        const follow = typeof p.follow === "boolean" ? p.follow : null;
        const total = upsertSourcesRespectingPlan(rt, p.sources, follow, boundProfileId, now);
        if (follow !== null && total > 0) rt.bumpAndPushConfig();
        rt.dedup.insert(msgId, [total, 0]);
        reply(msgId, "ack", { accepted: total, duplicates: 0 });
        return;
      }
      case "session.status": {
        const state = str(p, "state");
        if (!SESSION_STATES.includes(state)) throw CoreError.validation("invalid 'state'");
        if (isObj(p.runtime)) {
          const conn = rt.peers.get(connId);
          if (conn) conn.crawlRuntime = [now, p.runtime as CrawlRuntimeStatus];
        }
        handleSessionStatus(rt, state, now);
        reply(msgId, "ack", { accepted: 1, duplicates: 0 });
        return;
      }
      case "ping":
        reply(msgId, "pong", {});
        return;
      default:
        throw CoreError.validation("unsupported message body on IPC server");
    }
  };

  return {
    connId,
    consume(envelope: ProtocolEnvelope): void {
      if (detached) return;
      try {
        handleBody(envelope);
      } catch (err) {
        const [code, retryable] =
          err instanceof CoreError && err.kind === "validation"
            ? (["invalid_payload", false] as const)
            : err instanceof CoreError && err.kind === "shutting_down"
              ? (["busy", true] as const)
              : (["internal", true] as const);
        rt.log(`IPC message handler error (conn ${connId}): ${err instanceof Error ? err.message : String(err)}`);
        send(
          makeEnvelope(
            "error",
            { code, message: err instanceof Error ? err.message : String(err), retryable },
            envelope.id ?? null,
            rt.now(),
          ),
        );
      }
    },
    detach(): void {
      if (detached) return;
      detached = true;
      const removed = rt.peers.delete(connId);
      let becameAllDisconnected = false;
      if (removed && rt.peers.size === 0) {
        rt.lastDisconnectedAt = rt.now();
        becameAllDisconnected = true;
      }
      if (becameAllDisconnected || boundProfileId !== null) rt.emitHealthSoon(rt.now());
    },
  };
}
