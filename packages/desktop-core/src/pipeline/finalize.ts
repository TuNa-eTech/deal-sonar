// Port of crates/core/src/pipeline/finalize.rs: T6 postfilter, hard filters, scoring (T6) and
// lead creation + notification routing (T7).

import { classifyLeadTier, evaluateHardFilters, postprocessFields } from "../rules/postfilter";
import { sortedEntries } from "../rules/types";
import type { ExtractedField as StoreExtractedField } from "../store/domain";
import type { EvaluationRecord, FieldMap } from "../store/leads";
import type { PostRecord } from "../store/posts";
import type { RadarVersionRecord } from "../store/radars";
import type { NotifyConfig } from "../store/domain";
import {
  extractedFieldRulesToStore,
  feedbackLabelFromDb,
  leadDetailToLeadDto,
  leadExpiresAt,
  sortRecord,
} from "./dto";
import { routeLeadNotifications } from "./notify";
import type { PipelineRuntime } from "./runtime";
import { isPreview, type CandidateDecision, type EvalMode, type LeadDto } from "./types";

/** Load a complete lead DTO from the store (`load_lead_dto`). */
export function loadLeadDto(rt: PipelineRuntime, leadId: string): LeadDto | null {
  const detail = rt.store.leads.leadGet(leadId);
  if (!detail) return null;
  const rw = rt.store.radars.get(detail.lead.radar_id);
  const notify = rw?.radar.notify ?? null;
  const minScore = notify?.min_score ?? 0.6;
  const ttl = notify?.lead_ttl_hours ?? null;

  let label = null as ReturnType<typeof feedbackLabelFromDb>;
  for (let i = detail.events.length - 1; i >= 0; i -= 1) {
    const ev = detail.events[i];
    if (ev.kind === "feedback") {
      const d = ev.data as { label?: unknown } | null;
      label = typeof d?.label === "string" ? feedbackLabelFromDb(d.label) : null;
      break;
    }
  }
  if (label === null) label = feedbackLabelFromDb(rt.getEvalFeedbackLabels()[detail.lead.evaluation_id]);
  return leadDetailToLeadDto(detail, minScore, ttl, label);
}

/**
 * Execute T6 (evidence check, renormalization, peer override, `want_intent`, hard filters, score
 * tiers) and, for non-preview modes, T7 (contact link, lead creation, notifications).
 */
export function finalizeCandidateEvaluation(
  rt: PipelineRuntime,
  evaluationId: string,
  post: PostRecord,
  textNorm: string,
  radarId: string,
  radarName: string,
  radarStatus: string,
  radarNotify: NotifyConfig,
  radarVersion: RadarVersionRecord,
  decision: CandidateDecision,
  mode: EvalMode,
  now: number,
): EvaluationRecord {
  const fieldDefs = radarVersion.fields;
  const refTsMs = post.created_at ?? post.captured_at;

  // T6.1 + T6.2
  const post_ = postprocessFields(textNorm, fieldDefs, decision.candidateFields, refTsMs);
  const storeFields: FieldMap = {};
  for (const [k, v] of sortedEntries(post_.fields)) storeFields[k] = extractedFieldRulesToStore(v);

  const allPhones = [...post.extracted_phones];
  for (const def of fieldDefs) {
    if (def.type === "phone") {
      const ef = storeFields[def.key];
      if (ef && typeof ef.value === "string" && !allPhones.includes(ef.value)) allPhones.push(ef.value);
    }
  }

  // T6.3
  const peerSignals = rt.store.posts.getPeerSignals(post.id, allPhones, now);
  const effectiveRole = peerSignals.is_peer_override ? "peer" : decision.authorRole;

  const done = (input: {
    decidedBy: string;
    verdict: "match" | "no_match";
    rejectReason: string | null;
    score: number;
    reason: string;
    summary?: string;
  }): EvaluationRecord =>
    rt.store.leads.markEvaluationDone(evaluationId, {
      decided_by: input.decidedBy,
      verdict: input.verdict,
      reject_reason: input.rejectReason,
      score: input.score,
      intent: decision.intent,
      author_role: effectiveRole,
      summary: input.summary ?? decision.summary,
      reason: input.reason,
      fields: storeFields,
      ruleset_id: decision.rulesetId,
      ai_call_id: decision.aiCallId,
      decided_at: now,
    });

  if (decision.isSpam) {
    return done({ decidedBy: decision.isMatch ? "postfilter" : decision.decidedBy, verdict: "no_match", rejectReason: "spam", score: 0.0, reason: decision.reason });
  }

  const excludesPeer = radarVersion.match_policy.exclude_roles.includes("peer");
  if (excludesPeer && effectiveRole === "peer") {
    const reason =
      peerSignals.is_peer_override && decision.authorRole !== "peer"
        ? `Ghi đè người cùng nghề theo hành vi (${peerSignals.signal_count} tín hiệu: ${peerSignals.author_followed_posts_7d} bài/7n, ${peerSignals.cluster_source_count} nhóm trùng, ${peerSignals.max_distinct_authors_for_phone} tác giả dùng chung SĐT)`
        : decision.reason;
    return done({ decidedBy: decision.isMatch ? "postfilter" : decision.decidedBy, verdict: "no_match", rejectReason: "peer", score: 0.0, reason });
  }

  if (!decision.isMatch) {
    return done({
      decidedBy: decision.decidedBy,
      verdict: "no_match",
      rejectReason: "irrelevant",
      score: Math.min(0.39, Math.max(0, decision.rawScore)),
      reason: decision.reason,
    });
  }

  const wantIntent = radarVersion.match_policy.want_intent;
  const intentOk =
    wantIntent === "demand"
      ? decision.intent === "demand"
      : wantIntent === "supply"
        ? decision.intent === "supply"
        : decision.intent === "demand" || decision.intent === "supply";
  if (!intentOk) {
    return done({
      decidedBy: "postfilter",
      verdict: "no_match",
      rejectReason: "irrelevant",
      score: 0.2,
      reason: `Chiều bài đăng (${decision.intent}) không khớp yêu cầu radar (${wantIntent})`,
    });
  }

  // T6.4
  if (!evaluateHardFilters(radarVersion.match_policy.hard_filters, post_.fields)) {
    return done({
      decidedBy: "postfilter",
      verdict: "no_match",
      rejectReason: "hard_filter",
      score: decision.rawScore,
      reason: "Không đạt điều kiện lọc cứng (hard_filters)",
    });
  }

  // T6.5
  const adjustedScore = Math.min(1, Math.max(0, decision.rawScore - post_.score_penalty));
  const disposition = classifyLeadTier(adjustedScore, radarNotify.min_score);
  if (disposition === "discard") {
    return done({
      decidedBy: post_.score_penalty > 0 ? "postfilter" : decision.decidedBy,
      verdict: "no_match",
      rejectReason: "irrelevant",
      score: adjustedScore,
      reason: decision.reason,
    });
  }

  const evalDone = done({ decidedBy: decision.decidedBy, verdict: "match", rejectReason: null, score: adjustedScore, reason: decision.reason });

  if (isPreview(mode)) return evalDone;

  // T7
  const postDetail = rt.store.posts.get(post.id);
  const authorDisplayName = postDetail?.author_name ?? "Ẩn danh";
  const sourceName = postDetail?.source_name ?? "";
  const contact = rt.store.contacts.upsertFromLead(post.author_id, authorDisplayName, allPhones, now);

  const [leadRec, inserted] = rt.store.leads.createLead({
    id: null,
    radar_id: radarId,
    radar_version_id: radarVersion.id,
    post_id: post.id,
    evaluation_id: evalDone.id,
    contact_id: contact?.id ?? null,
    status: "new",
    score: adjustedScore,
    summary: decision.summary,
    fields: sortRecord(storeFields) as Record<string, StoreExtractedField>,
    also_seen_in: null,
    notified_at: null,
    follow_up_at: null,
    note: null,
    tags: [],
    now_ms: now,
  });
  if (!inserted) return evalDone;

  const exp = leadExpiresAt(post.created_at, post.captured_at, radarNotify.lead_ttl_hours ?? null);
  const alreadyExpired = exp !== null && exp <= now;

  if (disposition === "create_and_notify" && !alreadyExpired) {
    rt.spawn(
      routeLeadNotifications(rt, {
        lead: leadRec,
        post,
        sourceName,
        authorName: authorDisplayName,
        radarId,
        radarName,
        radarStatus,
        radarNotify,
        radarVersion,
        mode,
        now,
      }),
      `notify lead ${leadRec.id}`,
    );
  }

  const leadDto = loadLeadDto(rt, leadRec.id);
  if (leadDto) rt.emit("lead:new", leadDto);
  return evalDone;
}
