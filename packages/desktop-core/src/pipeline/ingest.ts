// Port of crates/core/src/pipeline/ingest.rs: T0-T2 post ingestion, normalization, dedup and the
// silent 24h backfill.

import { DEDUP_WINDOW_MS, NEAR_DUP_MAX_HAMMING, NEAR_DUP_MIN_CHARS, normalizeText } from "../rules/normalize";
import { extractVnPhone } from "../rules/extractors/phone";
import type { PostRecord } from "../store/posts";
import type { RadarWithVersion } from "../store/radars";
import type { SourceRecord } from "../store/sources";
import { extractE164PhonesLight } from "../store/util";
import { runEvaluateBatchForVersion } from "./ai-batch";
import { evaluatePostForRadarSync } from "./evaluate";
import { loadLeadDto } from "./finalize";
import type { PipelineRuntime } from "./runtime";

/** Wire `RawPost` (`01-protocol.md §4.3`). */
export interface RawPost {
  platform: string;
  post_id: string;
  source_external_id: string;
  permalink: string;
  author: { external_id?: string | null; name: string; is_anonymous: boolean };
  text: string;
  text_truncated: boolean;
  created_at?: number | null;
  captured_at: number;
  attachments?: unknown[];
  counts?: unknown;
  extraction: { strategy: string; profile_rev: number };
}

export type IngestPostOutcome =
  | { kind: "duplicate_stored"; post: PostRecord }
  | { kind: "cluster_duplicate"; post: PostRecord }
  | { kind: "processed"; post: PostRecord };

export const wasInserted = (o: IngestPostOutcome): boolean => o.kind !== "duplicate_stored";

/** Union of the light phone scan and the full Vietnamese phone extractor (E.164). */
export function collectE164Phones(textNorm: string): string[] {
  const out = extractE164PhonesLight(textNorm);
  for (const m of extractVnPhone(textNorm)) {
    if (typeof m.value === "string" && !out.includes(m.value)) out.push(m.value);
  }
  return out;
}

/** Synchronous T0-T4 ingestion of one raw post (`05-pipeline-rules.md §2-6`). Idempotent per `(platform, post_id)`. */
export function ingestRawPost(rt: PipelineRuntime, source: SourceRecord, raw: RawPost, now: number): IngestPostOutcome {
  const norm = normalizeText(raw.text);
  const phones = collectE164Phones(norm.text_norm);

  const [post, inserted] = rt.store.posts.insert({
    id: null,
    platform: raw.platform,
    external_id: raw.post_id,
    source_id: source.id,
    author: { external_id: raw.author.external_id ?? null, name: raw.author.name, is_anonymous: raw.author.is_anonymous },
    permalink: raw.permalink,
    text: raw.text,
    text_norm: norm.text_norm,
    text_fold: norm.text_fold,
    text_truncated: raw.text_truncated,
    lang: norm.lang,
    content_hash: norm.content_hash,
    simhash: norm.simhash,
    attachments: raw.attachments && raw.attachments.length > 0 ? raw.attachments : null,
    counts: raw.counts ?? null,
    extracted_phones: phones,
    created_at: raw.created_at ?? null,
    captured_at: raw.captured_at,
    strategy: raw.extraction.strategy,
  });
  if (!inserted) return { kind: "duplicate_stored", post };

  if (phones.length > 0) rt.store.posts.recordPhones(post.id, phones);

  const activeRadars = rt.store.radars.listActiveForSource(source.id);

  // T2: exact (content_hash, 14d) then near-duplicate (SimHash Hamming <= 3, >= 80 chars, 14d).
  const since14d = post.captured_at - DEDUP_WINDOW_MS;
  let matchedDup: PostRecord | null = rt.store.posts.findExactDup(post.content_hash, since14d, post.id);
  if (!matchedDup && Array.from(norm.text_norm).length >= NEAR_DUP_MIN_CHARS) {
    matchedDup = rt.store.posts.findSimhashDups(post.simhash, NEAR_DUP_MAX_HAMMING, since14d, post.id)[0]?.post ?? null;
  }

  let repostAfter72h = false;
  if (matchedDup) {
    const attach = rt.store.posts.createOrAttachDupCluster(matchedDup.id, post.id);
    for (const leadId of attach.updated_lead_ids) {
      const dto = loadLeadDto(rt, leadId);
      if (dto) rt.emit("lead:updated", dto);
    }
    if (!attach.is_repost_after_72h) {
      for (const rw of activeRadars) {
        rt.store.leads.upsertEvaluation({
          id: null,
          post_id: post.id,
          radar_version_id: rw.current_version.id,
          state: "done",
          decided_by: "dedup",
          verdict: "no_match",
          reject_reason: "duplicate",
          score: 0.0,
          intent: null,
          author_role: null,
          summary: null,
          reason: "Bài đăng trùng trong cụm 72 giờ",
          fields: null,
          ruleset_id: null,
          ai_call_id: null,
          is_preview: false,
          created_at: now,
          decided_at: now,
        });
      }
      return { kind: "cluster_duplicate", post };
    }
    repostAfter72h = true;
  }

  const postCurrent: PostRecord = rt.store.posts.get(post.id) ?? post;

  // T3-T4 per subscribed active radar.
  for (const rw of activeRadars) {
    evaluatePostForRadarSync(
      rt,
      postCurrent,
      norm,
      rw.radar.id,
      rw.radar.name,
      rw.radar.status,
      rw.radar.notify,
      rw.current_version,
      { kind: "live", repostAfter72h },
      now,
    );
  }
  return { kind: "processed", post: postCurrent };
}

/** Silent evaluation of the last 24h after `paused -> active` (`02-radar-spec.md §4`). */
export async function runSilentBackfill24h(rt: PipelineRuntime, rw: RadarWithVersion, now: number): Promise<number> {
  if (rw.source_ids.length === 0) return 0;
  const since24h = now - 24 * 3_600_000;
  const posts = rt.store.posts.listRecentForSources(rw.source_ids, 200, since24h);
  if (posts.length === 0) return 0;

  let queuedAi = false;
  let evaluated = 0;
  for (const post of posts) {
    if (!post.is_cluster_head) continue;
    const norm = normalizeText(post.text ?? "");
    const evalRec = evaluatePostForRadarSync(
      rt,
      post,
      norm,
      rw.radar.id,
      rw.radar.name,
      rw.radar.status,
      rw.radar.notify,
      rw.current_version,
      { kind: "backfill_silent" },
      now,
    );
    evaluated += 1;
    if (evalRec.state === "pending_ai") queuedAi = true;
  }
  if (queuedAi) await runEvaluateBatchForVersion(rt, rw.current_version.id, true);
  return evaluated;
}
