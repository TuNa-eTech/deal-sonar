import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AiProviderId,
  AiUsageStats,
  BlocklistEntry,
  BlocklistKind,
  Channel,
  ChromeConnectResult,
  Contact,
  ContactDetail,
  CrawlRun,
  CreateRadarDraftInput,
  FunnelStats,
  HealthStatus,
  LeadDetail,
  LeadExportInput,
  LeadExportResult,
  LeadFeedbackInput,
  LeadFeedbackResult,
  LeadFilterQuery,
  LeadListResponse,
  LeadStatus,
  LicenseStatus,
  ModelTierMap,
  Post,
  PreviewRunState,
  PreviewStartInput,
  ProbeResult,
  Radar,
  RadarDetail,
  RadarStatus,
  RadarTemplate,
  RadarUpdateResult,
  RejectedEvaluation,
  Ruleset,
  RulesetBody,
  Settings,
  Source,
  SuggestFieldsInput,
  SuggestFieldsResult,
  TauriEventMap,
  TelegramSetupStatus,
  UpdateRadarInput,
} from "../types/ipc";
import { invokeMockCommand, subscribeMockEvent } from "./mockBackend";

/**
 * Returns `true` only when running inside a real Tauri v2 WebView window.
 * Browser dev mode (`vite`) and Vitest (`jsdom`) automatically fall back to `mockBackend`.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function callCommand<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauriRuntime()) {
    return invoke<T>(cmd, args);
  }
  return invokeMockCommand<T>(cmd, args);
}

/**
 * Subscribe to a real-time backend push event (`03-desktop.md §4`):
 * `lead:new`, `lead:updated`, `preview:progress`, `health:changed`, `crawl:finished`, `job:failed`.
 */
export async function onDesktopEvent<K extends keyof TauriEventMap>(
  event: K,
  handler: (payload: TauriEventMap[K]) => void
): Promise<() => void> {
  if (isTauriRuntime()) {
    const unlisten = await listen<TauriEventMap[K]>(event, (ev) => {
      handler(ev.payload);
    });
    return unlisten;
  }
  return subscribeMockEvent(event, handler);
}

/**
 * Complete typed Tauri IPC client matching `03-desktop.md §4` (all snake_case commands).
 */
export const api = {
  workspaceAction: <T>(action:string,input:Record<string,unknown>={}) => callCommand<T>("workspace_action",{action,input}),
  // --- Radar ---
  radarList: () => callCommand<Radar[]>("radar_list"),
  radarGet: (id: string) => callCommand<RadarDetail>("radar_get", { id }),
  radarCreateDraft: (input: CreateRadarDraftInput) =>
    callCommand<RadarDetail>("radar_create_draft", { input }),
  radarUpdate: (input: UpdateRadarInput) =>
    callCommand<RadarUpdateResult>("radar_update", { input }),
  radarSuggestFields: (input: SuggestFieldsInput) =>
    callCommand<SuggestFieldsResult>("radar_suggest_fields", { input }),
  radarSetStatus: (id: string, status: RadarStatus) =>
    callCommand<Radar>("radar_set_status", { id, status }),
  radarPreviewStart: (input: PreviewStartInput) =>
    callCommand<PreviewRunState>("radar_preview_start", { input }),
  radarPreviewCancel: (radar_id: string, preview_id: string) =>
    callCommand<PreviewRunState>("radar_preview_cancel", { radar_id, preview_id }),
  radarPreviewGet: (radar_id: string, preview_id?: string) =>
    callCommand<PreviewRunState>("radar_preview_get", { radar_id, preview_id }),
  radarStats: (radar_id?: string | null, days = 7) =>
    callCommand<FunnelStats>("radar_stats", { radar_id: radar_id ?? null, days }),

  // --- Templates ---
  templateList: () => callCommand<RadarTemplate[]>("template_list"),
  templateGet: (id: string) => callCommand<RadarTemplate>("template_get", { id }),

  // --- Sources ---
  sourceList: () => callCommand<Source[]>("source_list"),
  sourceFollow: (id: string) => callCommand<Source>("source_follow", { id }),
  sourceUnfollow: (id: string) => callCommand<Source>("source_unfollow", { id }),
  sourceSetPriority: (id: string, priority: boolean) =>
    callCommand<Source>("source_set_priority", { id, priority }),
  sourceCrawlNow: (id: string, reason: "manual" | "preview" = "manual") =>
    callCommand<{ queued: boolean; run_id: string }>("source_crawl_now", { id, reason }),

  // --- Leads ---
  leadList: (query: LeadFilterQuery) =>
    callCommand<LeadListResponse>("lead_list", { query }),
  leadMarkRead: (id: string) => callCommand<LeadDetail>("lead_mark_read", { id }),
  leadGet: (id: string) => callCommand<LeadDetail>("lead_get", { id }),
  leadSetStatus: (
    id: string,
    status: LeadStatus,
    crmPatch?: { note?: string | null; tags?: string[] | null; follow_up_at?: number | null }
  ) =>
    callCommand<LeadDetail>("lead_set_status", {
      id,
      status,
      ...(crmPatch ?? {}),
    }),
  leadUpdateField: (id: string, field_key: string, value: unknown, raw?: string | null) =>
    callCommand<LeadDetail>("lead_update_field", { id, field_key, value, raw }),
  leadFeedback: (input: LeadFeedbackInput) =>
    callCommand<LeadFeedbackResult>("lead_feedback", { input }),
  leadExport: (input: LeadExportInput) =>
    callCommand<LeadExportResult>("lead_export", { input }),

  // --- Posts & Rejected Evaluations ---
  postGet: (id: string) => callCommand<Post>("post_get", { id }),
  postSearch: (query: string, source_id?: string | null, limit = 30) =>
    callCommand<Post[]>("post_search", { query, source_id: source_id ?? null, limit }),
  evaluationListRejected: (radar_id: string, limit = 30) =>
    callCommand<RejectedEvaluation[]>("evaluation_list_rejected", { radar_id, limit }),

  // --- Contacts & Blocklist ---
  contactList: (search?: string | null, limit = 100) =>
    callCommand<Contact[]>("contact_list", { search: search ?? null, limit }),
  contactGet: (id: string) => callCommand<ContactDetail>("contact_get", { id }),
  contactBlock: (id: string, reason?: string | null, radar_id?: string | null) =>
    callCommand<{ blocked_entries: BlocklistEntry[] }>("contact_block", {
      id,
      reason: reason ?? null,
      radar_id: radar_id ?? null,
    }),
  contactNote: (id: string, note: string) =>
    callCommand<Contact>("contact_note", { id, note }),
  blocklistList: (radar_id?: string | null) =>
    callCommand<BlocklistEntry[]>("blocklist_list", { radar_id: radar_id ?? null }),
  blocklistAdd: (
    kind: BlocklistKind,
    value: string,
    reason?: string | null,
    radar_id?: string | null
  ) =>
    callCommand<BlocklistEntry>("blocklist_add", {
      kind,
      value,
      reason: reason ?? null,
      radar_id: radar_id ?? null,
    }),
  blocklistRemove: (id: string) =>
    callCommand<{ removed: boolean }>("blocklist_remove", { id }),

  // --- Rulesets ---
  rulesetList: (radar_id: string, radar_version_id?: string | null) =>
    callCommand<Ruleset[]>("ruleset_list", {
      radar_id,
      radar_version_id: radar_version_id ?? null,
    }),
  rulesetSaveUser: (radar_id: string, radar_version_id: string, body: RulesetBody) =>
    callCommand<Ruleset>("ruleset_save_user", { radar_id, radar_version_id, body }),
  rulesetCompileNow: (radar_id: string) =>
    callCommand<{ job_id: string; ruleset: Ruleset | null }>("ruleset_compile_now", { radar_id }),

  // --- Settings, AI, Telegram, Channels, Webhook, Chrome, License ---
  settingsGet: () => callCommand<Settings>("settings_get"),
  settingsSet: (patch: Partial<Settings>) =>
    callCommand<Settings>("settings_set", { patch }),
  aiProbe: (provider?: AiProviderId | null) =>
    callCommand<Record<AiProviderId, ProbeResult>>("ai_probe", {
      provider: provider ?? null,
    }),
  aiSetProvider: (provider: AiProviderId, model_tiers?: ModelTierMap) =>
    callCommand<Settings>("ai_set_provider", { provider, model_tiers }),
  telegramSetToken: (token: string) =>
    callCommand<TelegramSetupStatus>("telegram_set_token", { token }),
  telegramTest: (channel_id?: string | null) =>
    callCommand<{ ok: boolean; message: string }>("telegram_test", {
      channel_id: channel_id ?? null,
    }),
  channelList: () => callCommand<Channel[]>("channel_list"),
  channelRemove: (id: string) =>
    callCommand<{ removed: boolean }>("channel_remove", { id }),
  webhookAdd: (name: string, url: string, secret?: string | null) =>
    callCommand<Channel>("webhook_add", { name, url, secret: secret ?? null }),
  chromeConnect: (opts?: { extension_id?: string | null; resume_crawl?: boolean }) =>
    callCommand<ChromeConnectResult>("chrome_connect", {
      extension_id: opts?.extension_id ?? null,
      resume_crawl: opts?.resume_crawl ?? false,
    }),
  licenseGet: () => callCommand<LicenseStatus>("license_get"),
  licenseSet: (license_key: string) =>
    callCommand<LicenseStatus>("license_set", { license_key }),

  // --- Health & Diagnostics ---
  healthGet: () => callCommand<HealthStatus>("health_get"),
  crawlRunList: (source_id?: string | null, limit = 50) =>
    callCommand<CrawlRun[]>("crawl_run_list", { source_id: source_id ?? null, limit }),
  aiUsageGet: (days = 7) => callCommand<AiUsageStats>("ai_usage_get", { days }),
  diagnosticBundleCreate: () =>
    callCommand<{ path: string; size_bytes: number; created_at: number }>(
      "diagnostic_bundle_create"
    ),

  // --- Data Lifecycle ---
  dataBackup: () =>
    callCommand<{ path: string; created_at: number }>("data_backup"),
  dataPurge: (unmatched_retention_days?: number) =>
    callCommand<{ posts_purged: number; evaluations_cleaned: number }>("data_purge", {
      unmatched_retention_days,
    }),
  dataDeleteAll: (confirm_phrase: string) =>
    callCommand<{ deleted: boolean }>("data_delete_all", { confirm_phrase }),
};
