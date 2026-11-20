// Store record <-> DTO converters (crates/core/src/dto/convert.rs and the `*_to_dto` helpers of
// crates/core/src/service/*.rs and pipeline/finalize.rs).

import type { RuntimeContext } from "../backend/runtime";
import type { ExtractedField, HardFilter, MatchPolicy, NotifyConfig } from "../store/domain";
import type { BlocklistRecord, ContactRecord } from "../store/contacts";
import type { LeadDetail as StoreLeadDetail } from "../store/leads";
import type { PostDetail } from "../store/posts";
import type { RadarVersionRecord } from "../store/radars";
import type { SourceListItem } from "../store/sources";
import { getEvalFeedbackLabels } from "./catalog-runtime";
import { isPlainObject } from "./catalog-serde";
import {
  type BlocklistEntryDto,
  type ContactDto,
  type ExtractedFieldDto,
  type FeedbackLabel,
  type LeadDto,
  type MatchPolicyDto,
  type PostDto,
  type RadarNotifyConfigDto,
  type RadarNotifyPatch,
  type RadarVersionDto,
  type SourceDto,
  authorRoleFromDb,
  blocklistKindFromDb,
  decidedByFromDb,
  feedbackLabelFromDb,
  leadStatusFromDb,
  notifyModeFromDb,
  sourceStateFromDb,
  wantIntentFromDb,
  whenMissingFromDb,
} from "./catalog-types";

/** Placeholder author shown when Facebook hides the poster. */
export const ANONYMOUS_AUTHOR = "Ẩn danh";

// ---- match policy / notify ---------------------------------------------------------------------

export function matchPolicyToStore(mp: MatchPolicyDto): MatchPolicy {
  return {
    want_intent: mp.want_intent,
    exclude_roles: [...mp.exclude_roles],
    hard_filters: mp.hard_filters.map(
      (hf): HardFilter => ({ field: hf.field, op: hf.op, value: hf.value, when_missing: hf.when_missing }),
    ),
  };
}

export function matchPolicyFromStore(mp: MatchPolicy): MatchPolicyDto {
  return {
    want_intent: wantIntentFromDb(mp.want_intent),
    exclude_roles: mp.exclude_roles.map(authorRoleFromDb),
    hard_filters: mp.hard_filters.map((hf) => ({
      field: hf.field,
      op: hf.op,
      value: hf.value === undefined ? null : hf.value,
      when_missing: whenMissingFromDb(hf.when_missing),
    })),
  };
}

export function notifyToStore(n: RadarNotifyConfigDto): NotifyConfig {
  return {
    channel_ids: [...n.channel_ids],
    ...(n.inherit_channels !== undefined ? { inherit_channels: n.inherit_channels } : {}),
    mode: n.mode,
    min_score: n.min_score,
    quiet_hours: n.quiet_hours ? { from: n.quiet_hours.from, to: n.quiet_hours.to } : null,
    ...(n.lead_ttl_hours !== null ? { lead_ttl_hours: n.lead_ttl_hours } : {}),
  };
}

export function notifyFromStore(n: NotifyConfig): RadarNotifyConfigDto {
  return {
    channel_ids: [...n.channel_ids],
    ...(n.inherit_channels !== undefined ? { inherit_channels: n.inherit_channels } : {}),
    mode: notifyModeFromDb(n.mode),
    min_score: n.min_score,
    quiet_hours: n.quiet_hours ? { from: n.quiet_hours.from, to: n.quiet_hours.to } : null,
    lead_ttl_hours: n.lead_ttl_hours ?? null,
  };
}

/** `RadarNotifyPatch::apply_onto`. */
export function applyNotifyPatch(patch: RadarNotifyPatch, base: RadarNotifyConfigDto): RadarNotifyConfigDto {
  const inherit = patch.inherit_channels ?? base.inherit_channels;
  let leadTtl: number | null;
  if (patch.lead_ttl_hours === undefined) leadTtl = base.lead_ttl_hours;
  else leadTtl = patch.lead_ttl_hours !== null && patch.lead_ttl_hours > 0 ? patch.lead_ttl_hours : null;
  return {
    channel_ids: patch.channel_ids ? [...patch.channel_ids] : [...base.channel_ids],
    ...(inherit !== undefined ? { inherit_channels: inherit } : {}),
    mode: patch.mode ?? base.mode,
    min_score: patch.min_score ?? base.min_score,
    quiet_hours: patch.quiet_hours === undefined ? base.quiet_hours : patch.quiet_hours,
    lead_ttl_hours: leadTtl,
  };
}

export function radarVersionFromStore(rv: RadarVersionRecord): RadarVersionDto {
  return {
    id: rv.id,
    radar_id: rv.radar_id,
    version: rv.version,
    description: rv.description,
    language_hint: rv.language_hint,
    user_profession: rv.user_profession,
    fields: rv.fields.map((f) => ({ ...f, options: f.options ? [...f.options] : null })),
    match_policy: matchPolicyFromStore(rv.match_policy),
    created_at: rv.created_at,
  };
}

// ---- sources / posts ---------------------------------------------------------------------------

export function sourceToDto(item: SourceListItem, lastError: string | null): SourceDto {
  return {
    id: item.id,
    platform: item.platform,
    kind: item.kind,
    external_id: item.external_id,
    name: item.name,
    url: item.url,
    privacy: item.privacy,
    member_count: item.member_count,
    profile_id: item.profile_id,
    followed: item.followed,
    priority: item.priority > 0,
    state: sourceStateFromDb(item.state),
    last_crawl_at: item.last_crawl_at,
    avg_new_posts: item.avg_new_posts,
    posts_per_day: item.posts_last_24h,
    stored_post_count: item.stored_post_count,
    last_error: lastError,
    created_at: item.created_at,
  };
}

export function postDetailToDto(detail: PostDetail): PostDto {
  return {
    id: detail.id,
    platform: detail.platform,
    external_id: detail.external_id,
    source_id: detail.source_id,
    source_name: detail.source_name,
    author_id: detail.author_id,
    author_name: detail.author_name ?? ANONYMOUS_AUTHOR,
    permalink: detail.permalink,
    text: detail.text,
    text_truncated: detail.text_truncated,
    lang: detail.lang,
    created_at: detail.created_at,
    captured_at: detail.captured_at,
    strategy: detail.strategy,
    purged_at: detail.purged_at,
  };
}

// ---- contacts / blocklist ----------------------------------------------------------------------

export function contactRecordToDto(c: ContactRecord, leadCount: number, blocklist: BlocklistRecord[]): ContactDto {
  const isBlocked = blocklist.some((b) => {
    if (b.kind === "phone") return c.phones.includes(b.value);
    if (b.kind === "author") return c.author_ids.includes(b.value);
    return false;
  });
  return {
    id: c.id,
    display_name: c.display_name ?? "Liên hệ chưa rõ tên",
    phones: [...c.phones],
    author_ids: [...c.author_ids],
    note: c.note,
    lead_count: leadCount,
    is_blocked: isBlocked,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

export function blocklistRecordToDto(b: BlocklistRecord, displayLabel: string | null): BlocklistEntryDto {
  return {
    id: b.id,
    kind: blocklistKindFromDb(b.kind),
    value: b.value,
    display_label: displayLabel,
    radar_id: b.radar_id,
    reason: b.reason,
    created_at: b.created_at,
  };
}

// ---- leads -------------------------------------------------------------------------------------

/** `lead_expires_at`: post time (or capture time) plus the radar's lifetime. */
export function leadExpiresAt(postCreatedAt: number | null, capturedAt: number, ttlHours: number | null): number | null {
  return ttlHours === null ? null : (postCreatedAt ?? capturedAt) + ttlHours * 3_600_000;
}

export function extractedFieldFromStore(ef: ExtractedField): ExtractedFieldDto {
  return { value: ef.value === undefined ? null : ef.value, raw: ef.raw ?? null, confidence: ef.confidence, source: ef.source };
}

/** `lead_detail_to_lead_dto`. */
export function leadDetailToLeadDto(
  detail: StoreLeadDetail,
  minScore: number,
  leadTtlHours: number | null,
  feedbackLabel: FeedbackLabel | null,
): LeadDto {
  const fields: Record<string, ExtractedFieldDto> = {};
  for (const [key, value] of Object.entries(detail.lead.fields)) fields[key] = extractedFieldFromStore(value);
  return {
    id: detail.lead.id,
    radar_id: detail.lead.radar_id,
    radar_name: detail.radar_name,
    radar_version_id: detail.lead.radar_version_id,
    radar_version: detail.evaluation.radar_version,
    post_id: detail.lead.post_id,
    evaluation_id: detail.lead.evaluation_id,
    contact_id: detail.lead.contact_id,
    status: leadStatusFromDb(detail.lead.status),
    read_at: detail.lead.read_at,
    score: detail.lead.score,
    is_weak_match: detail.lead.score < minScore,
    summary: detail.lead.summary,
    reason: detail.evaluation.reason,
    decided_by: decidedByFromDb(detail.evaluation.decided_by),
    fields,
    source_id: detail.source_id,
    source_name: detail.source_name,
    author_id: detail.author_id,
    author_name: detail.author_name ?? ANONYMOUS_AUTHOR,
    permalink: detail.permalink,
    post_created_at: detail.post_created_at,
    expires_at: leadExpiresAt(detail.post_created_at, detail.post_captured_at, leadTtlHours),
    also_seen_in: detail.lead.also_seen_in.map((e) => ({
      source_id: e.source_id,
      source_name: e.source_name,
      permalink: e.permalink,
      captured_at: e.captured_at,
    })),
    notified_at: detail.lead.notified_at,
    follow_up_at: detail.lead.follow_up_at,
    note: detail.lead.note,
    tags: [...detail.lead.tags],
    feedback_label: feedbackLabel,
    created_at: detail.lead.created_at,
    updated_at: detail.lead.updated_at,
  };
}

/** `load_lead_dto`: a complete `Lead` DTO by id, or `null` when it does not exist. */
export function loadLeadDto(ctx: RuntimeContext, leadId: string): LeadDto | null {
  const detail = ctx.store.leads.leadGet(leadId);
  if (!detail) return null;
  const rw = ctx.store.radars.get(detail.lead.radar_id);
  const minScore = rw ? rw.radar.notify.min_score : 0.6;
  const ttl = rw ? (rw.radar.notify.lead_ttl_hours ?? null) : null;

  let label: FeedbackLabel | null = null;
  for (let i = detail.events.length - 1; i >= 0; i -= 1) {
    const ev = detail.events[i];
    if (ev.kind !== "feedback") continue;
    const data = ev.data;
    if (isPlainObject(data) && typeof data.label === "string") label = feedbackLabelFromDb(data.label);
    break;
  }
  if (label === null) {
    try {
      const stored = getEvalFeedbackLabels(ctx)[detail.lead.evaluation_id];
      label = stored === undefined ? null : feedbackLabelFromDb(stored);
    } catch {
      label = null; // `.ok()`: an unreadable label map must not hide the lead.
    }
  }
  return leadDetailToLeadDto(detail, minScore, ttl, label);
}
