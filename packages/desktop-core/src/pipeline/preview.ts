// Port of crates/core/src/preview_rules/preview.rs: streaming radar preview lifecycle
// (`02-radar-spec.md §5`, `05-pipeline-rules.md §10`).

import { CoreError, toWireError } from "../backend/wire";
import { normalizeText } from "../rules/normalize";
import type { RadarVersionRecord, RadarWithVersion } from "../store/radars";
import type { PostRecord } from "../store/posts";
import { newUlid } from "../store/util";
import {
  buildRadarPromptContext,
  PREVIEW_BATCH,
  aiCoreError,
  callStatusOf,
  mergeCandidateFields,
  recordAiCalls,
  requireAi,
  toPromptPosts,
} from "./ai-batch";
import { feedbackLabelFromDb, previewEvalItemToDto } from "./dto";
import { evaluatePostForRadarSync } from "./evaluate";
import { finalizeCandidateEvaluation } from "./finalize";
import { makeEnvelope, type PipelineRuntime } from "./runtime";
import type { PreviewItem, PreviewRunState, PreviewStartInput, PreviewWarning } from "./types";

interface SavedDraftPreview {
  id: string;
  version_id: string;
  source_ids: string[];
  total_posts: number;
}

const isActive = (s: PreviewRunState["status"]): boolean => s === "crawling" || s === "evaluating";
const cloneState = (s: PreviewRunState): PreviewRunState => structuredClone(s);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Rust `{:.0}`: round half to even for exact ties. */
export function formatPct0(x: number): string {
  const frac = Math.abs(x % 1);
  if (frac === 0.5) return String(2 * Math.round(x / 2));
  return String(Math.round(x));
}

export function emitPreviewProgress(rt: PipelineRuntime, state: PreviewRunState, newItems: PreviewItem[]): void {
  rt.emit("preview:progress", {
    preview_id: state.preview_id,
    radar_id: state.radar_id,
    status: state.status,
    evaluated_posts: state.evaluated_posts,
    failed_posts: state.failed_posts,
    total_posts: state.total_posts,
    new_items: newItems,
    warnings: state.warnings,
    error: state.error,
  });
}

export function savePreviewState(rt: PipelineRuntime, state: PreviewRunState): void {
  rt.latestPreviewByRadar.set(state.radar_id, state.preview_id);
  rt.previews.set(state.preview_id, cloneState(state));
}

/** The 3 preview quality warnings: zero matches, too broad (> 60%), required field missing (> 70%). */
export function computePreviewWarnings(items: readonly PreviewItem[], ver: RadarVersionRecord): PreviewWarning[] {
  if (items.length === 0) {
    return [
      {
        code: "zero_matches",
        message: "Chưa có bài khớp trong mẫu thử. Hãy thử nới điều kiện hoặc thêm nhóm Facebook.",
      },
    ];
  }
  const warnings: PreviewWarning[] = [];
  const matched = items.filter((i) => i.verdict === "match");
  if (matched.length === 0) {
    warnings.push({ code: "zero_matches", message: "Không có bài nào khớp — mô tả có thể quá hẹp hoặc nhóm chưa có bài phù hợp." });
    return warnings;
  }
  const ratio = matched.length / items.length;
  if (ratio > 0.6) {
    warnings.push({
      code: "too_broad",
      message: `Có tới ${formatPct0(ratio * 100)}% số bài khớp (> 60%) — mô tả radar quá rộng, có thể gây nhiều thông báo nhiễu.`,
    });
  }
  for (const field of ver.fields.filter((f) => f.required)) {
    const missing = matched.filter((m) => !has(m.fields, field.key)).length;
    const missingRatio = missing / matched.length;
    if (missingRatio > 0.7) {
      warnings.push({
        code: "missing_required_field",
        field_key: field.key,
        field_label: field.label,
        message: `Trường bắt buộc '${field.label}' vắng mặt ở ${formatPct0(missingRatio * 100)}% bài khớp — nên tắt bắt buộc hoặc chỉnh mô tả trường.`,
      });
    }
  }
  return warnings;
}

class PreviewAbort extends Error {
  constructor(readonly why: "cancel" | "shutdown" | "timeout") {
    super(why);
  }
}

function abortToError(why: PreviewAbort["why"]): CoreError {
  if (why === "shutdown") return CoreError.shuttingDown();
  if (why === "timeout") {
    return CoreError.validation("Xem thử vượt quá 5 phút. Hãy kiểm tra AI và thử lại với ít bài hơn.");
  }
  return CoreError.validation("Đã dừng xem thử.");
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/**
 * Start an interactive streaming preview run. Returns the initial state immediately; evaluation
 * continues in the background, emitting `preview:progress` after every chunk.
 */
export function startRadarPreview(rt: PipelineRuntime, input: PreviewStartInput): PreviewRunState {
  const now = rt.now();
  const limits = rt.licenseLimits(now);
  if (input.fields && input.fields.length > limits.max_fields_per_radar) {
    throw CoreError.validation("Số trường vượt giới hạn gói hiện tại.");
  }
  const rw = rt.store.radars.get(input.radar_id);
  if (!rw) throw CoreError.notFound("radar", input.radar_id);

  const baseVer = rw.candidate_version ?? rw.current_version;
  const draftEffective: RadarVersionRecord = {
    id: baseVer.id,
    radar_id: rw.radar.id,
    version: baseVer.version,
    description: input.description ?? baseVer.description,
    language_hint: baseVer.language_hint,
    user_profession: has(input, "user_profession") && input.user_profession !== undefined ? input.user_profession : baseVer.user_profession,
    fields: input.fields ?? baseVer.fields,
    match_policy: input.match_policy ?? baseVer.match_policy,
    created_at: baseVer.created_at,
  };
  const effectiveVer = rt.store.radars.previewSnapshot(draftEffective);

  const sourceIds = [...(input.source_ids ?? rw.source_ids)];
  const sortedSources = [...sourceIds].sort();
  const savedSources = [...rw.source_ids].sort();
  const savedDraft =
    rw.radar.status === "draft" &&
    effectiveVer.id === rw.current_version.id &&
    JSON.stringify(sortedSources) === JSON.stringify(savedSources);
  const savedPreviewKey = `radar.saved_preview.${rw.radar.id}`;

  if (sourceIds.length === 0) throw CoreError.validation("Hãy chọn ít nhất một group nguồn.");
  for (const id of sourceIds) {
    if (!rt.store.sources.get(id)) throw CoreError.notFound("source", id);
  }
  const initialPosts = rt.store.posts.listRecentForSources(sourceIds, rt.config.previewMaxPosts);

  const state: PreviewRunState = {
    preview_id: newUlid(),
    radar_id: rw.radar.id,
    radar_version: effectiveVer.version,
    source_ids: sourceIds,
    status: initialPosts.length === 0 ? "crawling" : "evaluating",
    total_posts: initialPosts.length,
    evaluated_posts: 0,
    failed_posts: 0,
    items: [],
    warnings: [],
    error: null,
  };

  // Reserve before any asynchronous work: a second start must never clobber a running preview.
  const runningId = rt.latestPreviewByRadar.get(state.radar_id);
  const running = runningId ? rt.previews.get(runningId) : undefined;
  if (running && isActive(running.status)) {
    throw CoreError.validation("Radar đang xem thử. Hãy dừng phiên hiện tại trước khi chạy lại.");
  }
  rt.store.settings.delete(savedPreviewKey);
  rt.latestPreviewByRadar.set(state.radar_id, state.preview_id);
  rt.previews.set(state.preview_id, cloneState(state));

  const initial = cloneState(state);
  const abort = new AbortController();
  rt.previewCancellations.set(state.preview_id, abort);
  let why: PreviewAbort["why"] = "cancel";
  const fail = (w: PreviewAbort["why"]): void => {
    if (abort.signal.aborted) return;
    why = w;
    abort.abort();
  };
  const onShutdown = (): void => fail("shutdown");
  if (rt.shuttingDown) onShutdown();
  else rt.shutdown.signal.addEventListener("abort", onShutdown, { once: true });
  const timer = setTimeout(() => fail("timeout"), rt.config.previewTimeoutMs);

  const run = async (): Promise<void> => {
    const check = (): void => {
      if (abort.signal.aborted) throw new PreviewAbort(why);
    };
    // Settle immediately when the run is aborted, like the Rust `select!` dropping the work future.
    const abortable = <T>(p: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (abort.signal.aborted) {
          reject(new PreviewAbort(why));
          return;
        }
        abort.signal.addEventListener("abort", () => reject(new PreviewAbort(why)), { once: true });
        p.then(resolve, reject);
      });
    try {
      rt.store.leads.cleanupPreviewEvaluations(effectiveVer.id, null);
      let posts: PostRecord[] = initialPosts;
      if (posts.length < rt.config.previewMinPostsBeforeCrawl) {
        for (const sid of sourceIds) {
          const src = rt.store.sources.get(sid);
          if (src) {
            const env = makeEnvelope(
              "crawl.request",
              {
                request_id: newUlid(),
                source_ref: { platform: src.platform, kind: src.kind, external_id: src.external_id },
                reason: "preview",
                max_posts: 25,
              },
              null,
              rt.now(),
            );
            rt.sendToProfile(src.profile_id, env);
          }
        }
      }
      // An empty local dataset waits briefly for the requested crawl; never report a successful
      // zero-result evaluation while the crawl is still pending.
      if (posts.length === 0 && rt.isAnyConnected()) {
        const attempts = Math.max(1, Math.round(rt.config.previewCrawlWaitMs / rt.config.previewPollMs));
        for (let i = 0; i < attempts; i += 1) {
          await sleep(rt.config.previewPollMs, abort.signal);
          check();
          posts = rt.store.posts.listRecentForSources(sourceIds, rt.config.previewMaxPosts);
          if (posts.length > 0) break;
        }
      }
      state.total_posts = posts.length;
      if (posts.length === 0) {
        throw CoreError.validation(
          "Chưa có bài để xem thử. Hãy kiểm tra kết nối Chrome và thu thập bài từ các group đã chọn, rồi chạy lại.",
        );
      }
      state.status = "evaluating";
      savePreviewState(rt, state);
      emitPreviewProgress(rt, state, []);
      state.status = await evaluatePreviewPosts(rt, rw, effectiveVer, posts, state, { check, abortable });
    } catch (err) {
      if (err instanceof PreviewAbort) state.error = abortToError(err.why).message;
      else state.error = toWireError(err).message;
      state.status = "error";
    } finally {
      clearTimeout(timer);
      rt.shutdown.signal.removeEventListener("abort", onShutdown);
    }

    if (savedDraft && state.status === "done" && state.total_posts > 0) {
      const saved: SavedDraftPreview = {
        id: state.preview_id,
        version_id: effectiveVer.id,
        source_ids: sortedSources,
        total_posts: state.total_posts,
      };
      try {
        rt.store.settings.set(savedPreviewKey, saved);
      } catch (error) {
        rt.log(`Could not retain preview for a saved draft: ${toMessage(error)}`);
      }
    }
    savePreviewState(rt, state);
    emitPreviewProgress(rt, state, []);
    rt.previewCancellations.delete(initial.preview_id);
  };
  rt.spawn(run(), `preview ${initial.preview_id}`);
  return initial;
}

const toMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Request cancellation and wait until the run leaves `crawling`/`evaluating`. */
export async function cancelRadarPreview(rt: PipelineRuntime, radarId: string, previewId: string): Promise<PreviewRunState> {
  let state = getRadarPreview(rt, radarId, previewId);
  rt.previewCancellations.get(previewId)?.abort();
  if (isActive(state.status)) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 10));
      state = getRadarPreview(rt, radarId, previewId);
      if (!isActive(state.status)) return state;
    }
  }
  return state;
}

interface AbortGuard {
  check: () => void;
  abortable: <T>(p: Promise<T>) => Promise<T>;
}

async function evaluatePreviewPosts(
  rt: PipelineRuntime,
  rw: RadarWithVersion,
  effectiveVer: RadarVersionRecord,
  posts: readonly PostRecord[],
  state: PreviewRunState,
  guard: AbortGuard,
): Promise<"done" | "error"> {
  const { check, abortable } = guard;
  const now = rt.now();
  // Step 1: T3-T4 on every post (T2 dedup intentionally skipped so duplicates are visible).
  const doneImmediately: string[] = [];
  for (const post of posts) {
    const norm = normalizeText(post.text ?? "");
    const ev = evaluatePostForRadarSync(
      rt,
      post,
      norm,
      rw.radar.id,
      rw.radar.name,
      rw.radar.status,
      rw.radar.notify,
      effectiveVer,
      { kind: "preview" },
      now,
    );
    if (ev.state === "done") doneImmediately.push(ev.id);
  }
  check();

  if (doneImmediately.length > 0) {
    const ids = new Set(doneImmediately);
    const newItems = rt.store.leads
      .listPreviewEvaluations(effectiveVer.id)
      .filter((it) => ids.has(it.evaluation.id))
      .map(previewEvalItemToDto);
    state.evaluated_posts += newItems.length;
    state.items.push(...newItems);
    savePreviewState(rt, state);
    emitPreviewProgress(rt, state, newItems);
  }

  // Step 2: pending_ai preview posts in streaming batches of `previewBatchSize`.
  const postIds = new Set(posts.map((p) => p.id));
  const pending = rt.store.leads
    .listPendingAiForVersion(effectiveVer.id, true, rt.config.previewMaxPosts)
    .filter((it) => postIds.has(it.post.id));
  if (pending.length > 0) {
    const ai = requireAi(rt);
    const ctx = buildRadarPromptContext(rt, effectiveVer);
    const chunkSize = Math.max(rt.config.previewBatchSize, 1);
    for (let off = 0; off < pending.length; off += chunkSize) {
      check();
      const chunk = pending.slice(off, off + chunkSize);
      const promptPosts = toPromptPosts(chunk);
      const started = Date.now();
      let report;
      try {
        report = await abortable(rt.withInflightAi(() => ai.judgeExtractAll(ctx, promptPosts, PREVIEW_BATCH)));
      } catch (err) {
        if (err instanceof PreviewAbort) throw err;
        check();
        const chunkNow = rt.now();
        const call = rt.store.aiCalls.record({
          id: null,
          provider: ai.providerId(),
          model: null,
          task: "judge_extract",
          radar_version_id: effectiveVer.id,
          item_count: chunk.length,
          input_tokens: null,
          output_tokens: null,
          cost_usd: null,
          duration_ms: Date.now() - started,
          status: callStatusOf(err),
          error: toMessage(err),
          now_ms: chunkNow,
        });
        for (const item of chunk) rt.store.leads.markEvaluationAiFailed(item.evaluation.id, call.id, toMessage(err), chunkNow);
        state.failed_posts += chunk.length;
        throw aiCoreError(err);
      }
      check();
      const chunkNow = rt.now();
      const lastCallId = recordAiCalls(rt, report.calls, chunkNow);
      const byPost = new Map(chunk.map((it) => [it.post.id, it]));
      const chunkEvalIds: string[] = [];
      for (const outcome of report.outcomes) {
        const it = byPost.get(outcome.post_id);
        if (outcome.state === "ai_failed") {
          state.failed_posts += 1;
          if (it) rt.store.leads.markEvaluationAiFailed(it.evaluation.id, lastCallId, outcome.error, chunkNow);
          continue;
        }
        if (!it) continue;
        const r = outcome.result;
        const finalized = finalizeCandidateEvaluation(
          rt,
          it.evaluation.id,
          it.post,
          it.post.text_norm ?? it.post.text ?? "",
          rw.radar.id,
          rw.radar.name,
          rw.radar.status,
          rw.radar.notify,
          effectiveVer,
          {
            decidedBy: "ai",
            rulesetId: null,
            aiCallId: lastCallId,
            isMatch: r.match,
            rawScore: r.score,
            intent: r.intent,
            authorRole: r.author_role,
            isSpam: r.is_spam,
            summary: r.summary,
            reason: r.reason,
            candidateFields: mergeCandidateFields(it, r.fields),
          },
          { kind: "preview" },
          chunkNow,
        );
        chunkEvalIds.push(finalized.id);
      }
      const ids = new Set(chunkEvalIds);
      const chunkItems = rt.store.leads
        .listPreviewEvaluations(effectiveVer.id)
        .filter((it) => ids.has(it.evaluation.id))
        .map(previewEvalItemToDto);
      state.evaluated_posts += chunkItems.length;
      state.items.push(...chunkItems);
      savePreviewState(rt, state);
      emitPreviewProgress(rt, state, chunkItems);
    }
  }

  // Matches first by score desc, then non-matches by score desc.
  state.items.sort((a, b) => {
    const am = a.verdict === "match";
    const bm = b.verdict === "match";
    if (am !== bm) return am ? -1 : 1;
    return b.score > a.score ? 1 : b.score < a.score ? -1 : 0;
  });
  if (state.failed_posts > 0) {
    state.error = `${state.failed_posts} bài không chấm được. Kết quả đã hoàn tất vẫn được giữ; hãy kiểm tra AI và chạy lại.`;
  }
  state.warnings = state.failed_posts === 0 ? computePreviewWarnings(state.items, effectiveVer) : [];
  return state.failed_posts === 0 ? "done" : "error";
}

/** Fetch a preview run by `(radar_id, optional preview_id)`; rebuilds from DB rows after a restart. */
export function getRadarPreview(rt: PipelineRuntime, radarId: string, previewId: string | null): PreviewRunState {
  const resolvedId = previewId ?? rt.latestPreviewByRadar.get(radarId) ?? null;
  if (resolvedId) {
    const existing = rt.previews.get(resolvedId);
    if (existing) {
      const st = cloneState(existing);
      if (st.radar_id !== radarId) throw CoreError.validation("Phiên xem thử không thuộc Radar này.");
      const labels = rt.getEvalFeedbackLabels();
      for (const item of st.items) item.feedback_label = feedbackLabelFromDb(labels[item.evaluation_id]);
      return st;
    }
  }

  const rw = rt.store.radars.get(radarId);
  if (!rw) throw CoreError.notFound("radar", radarId);
  const ver = rw.candidate_version ?? rw.current_version;
  const rows = rt.store.leads.listPreviewEvaluations(ver.id);
  const failedPosts = rows.filter((r) => r.evaluation.state === "ai_failed").length;
  const incomplete = rows.some((r) => r.evaluation.state !== "done");
  const items = rows.filter((r) => r.evaluation.state === "done").map(previewEvalItemToDto);
  const warnings = computePreviewWarnings(items, ver);
  const sourceIds = [...rw.source_ids].sort();
  const savedRaw = rt.store.settings.get<SavedDraftPreview>(`radar.saved_preview.${radarId}`);
  const saved =
    savedRaw &&
    !incomplete &&
    savedRaw.total_posts === rows.length &&
    savedRaw.version_id === ver.id &&
    JSON.stringify(savedRaw.source_ids) === JSON.stringify(sourceIds) &&
    (previewId === null || previewId === savedRaw.id)
      ? savedRaw
      : null;

  const out: PreviewRunState = {
    preview_id: saved ? saved.id : (previewId ?? "restored"),
    radar_id: radarId,
    radar_version: ver.version,
    status: incomplete ? "error" : "done",
    total_posts: rows.length,
    evaluated_posts: items.length,
    failed_posts: failedPosts,
    items,
    warnings,
    error: incomplete ? "Phiên xem thử bị gián đoạn. Hãy chạy lại." : null,
  };
  if (saved) out.source_ids = saved.source_ids;
  // Wire field order of the Rust struct.
  return {
    preview_id: out.preview_id,
    radar_id: out.radar_id,
    radar_version: out.radar_version,
    ...(out.source_ids ? { source_ids: out.source_ids } : {}),
    status: out.status,
    total_posts: out.total_posts,
    evaluated_posts: out.evaluated_posts,
    failed_posts: out.failed_posts,
    items: out.items,
    warnings: out.warnings,
    error: out.error,
  };
}
