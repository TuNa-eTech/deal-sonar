// Port of the OS-notification fallback of crates/core/src/pipeline/notify.rs. Channel routing
// (quiet hours, digest/flood policy, Telegram/webhook outbox rows, `notify_lead` job) is delegated
// to `PipelineHooks.notify.routeLead`; without that hook a created lead stays visible in the app
// and the skipped routing is logged (no fabricated delivery).

import type { PipelineRuntime } from "./runtime";
import { isSilentOrPreview, type LeadNotificationInput } from "./types";

const SIX_HOURS_MS = 6 * 3_600_000;

export async function routeLeadNotifications(rt: PipelineRuntime, input: LeadNotificationInput): Promise<void> {
  const { lead, post, radarName, radarStatus, radarNotify, mode, now } = input;
  const settings = rt.loadSettings();
  const channels = rt.store.channels.list();
  const hasTelegramConfigured = channels.some((c) => c.kind === "telegram") && (await rt.telegramTokenPresent(now));

  const localOnly = radarNotify.inherit_channels === false && radarNotify.channel_ids.length === 0;
  if (
    (localOnly || !hasTelegramConfigured) &&
    settings.os_notifications_enabled &&
    !isSilentOrPreview(mode) &&
    radarStatus === "active" &&
    now - post.captured_at <= SIX_HOURS_MS
  ) {
    rt.notifyOs({ lead_id: lead.id, radar_name: radarName, summary: lead.summary });
  }

  if (rt.hooks.notify) {
    await rt.hooks.notify.routeLead(input);
  } else {
    rt.log(`notification routing skipped for lead ${lead.id}: no notification hook installed`);
  }
}
