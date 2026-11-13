// 2. Telegram & Quiet Hours / Digest (`07-notifications-export.md §2–4`)

import React from "react";
import { api } from "../../lib/api";
import type { SettingsScreenModel } from "./useSettingsScreen";

export const NotificationsSection: React.FC<{ s: SettingsScreenModel }> = ({ s }) => {
  const {
    draft,
    setDraft,
    section,
    channels,
    tgToken,
    setTgToken,
    whName,
    setWhName,
    whUrl,
    setWhUrl,
    whSecret,
    setWhSecret,
    whPrivacyAck,
    setWhPrivacyAck,
    setBanner,
    loadAux,
    savePatch,
  } = s;

  return (
    <div className="settings-section" hidden={section!=="notifications"}>
      <h3 style={{ marginTop: 0 }}>2. Kênh Telegram, Chế độ gửi gộp & Giờ yên lặng</h3>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="password"
          className="input"
          style={{ maxWidth: 360 }}
          placeholder="Cập nhật Bot Token Telegram (lưu trong Kho khoá hệ điều hành)…"
          value={tgToken}
          onChange={(e) => setTgToken(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            try {
              await api.telegramSetToken(tgToken);
              setTgToken("");
              await loadAux();
              setBanner({ kind: "ok", text: "Đã lưu Token Telegram vào Kho khoá hệ điều hành." });
            } catch (err) {
              setBanner({ kind: "err", text: err instanceof Error ? err.message : String(err) });
            }
          }}
        >
          Cập nhật Token
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const res = await api.telegramTest();
            setBanner({ kind: "ok", text: res.message });
          }}
        >
          Gửi tin thử
        </button>
      </div>

      <div className="settings-fields">
        <div>
          <label className="field-label">Chế độ báo cho radar tạo mới</label>
          <select
            className="select"
            value={draft.default_notify_mode}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                default_notify_mode: e.target.value as "instant" | "digest",
              }))
            }
          >
            <option value="instant">Tức thời (instant)</option>
            <option value="digest">Gửi gộp định kỳ (digest)</option>
          </select>
        </div>
        <div>
          <label className="field-label">Chu kỳ gửi gộp (phút)</label>
          <input
            type="number"
            className="input"
            min={10}
            max={180}
            value={draft.digest_interval_minutes}
            onChange={(e) =>
              setDraft((d) => ({ ...d, digest_interval_minutes: Number(e.target.value) || 30 }))
            }
          />
        </div>
        <div>
          <label className="field-label">Giờ yên lặng (Từ – Đến)</label>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={draft.quiet_hours_enabled}
              onChange={(e) =>
                setDraft((d) => ({ ...d, quiet_hours_enabled: e.target.checked }))
              }
            />
            <input
              type="time"
              className="input"
              value={draft.quiet_hours.from}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  quiet_hours: { ...d.quiet_hours, from: e.target.value },
                }))
              }
            />
            <input
              type="time"
              className="input"
              value={draft.quiet_hours.to}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  quiet_hours: { ...d.quiet_hours, to: e.target.value },
                }))
              }
            />
          </div>
        </div>
        <div>
          <label className="field-label">Thông báo hệ điều hành</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
            <input
              type="checkbox"
              checked={draft.os_notifications_enabled}
              onChange={(e) =>
                setDraft((d) => ({ ...d, os_notifications_enabled: e.target.checked }))
              }
            />
            <span>Bật thông báo màn hình</span>
          </label>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() =>
          void savePatch({
            default_notify_mode: draft.default_notify_mode,
            digest_interval_minutes: draft.digest_interval_minutes,
            quiet_hours_enabled: draft.quiet_hours_enabled,
            quiet_hours: draft.quiet_hours,
            os_notifications_enabled: draft.os_notifications_enabled,
          })
        }
      >
        Lưu tuỳ chọn thông báo
      </button>

      {/* Connected Channels List + Webhook (`07-notifications-export.md §6`) */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <strong>Các kênh nhận tin đang hoạt động ({channels.length}) & Webhook:</strong>
        <ul style={{ paddingLeft: 18, margin: "8px 0" }}>
          {channels.map((ch) => (
            <li key={ch.id} style={{ marginBottom: 4 }}>
              <span className="badge">{ch.kind}</span> <strong>{ch.name}</strong>{" "}
              {ch.config.url ? `(${ch.config.url})` : ""} ·{" "}
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  await api.channelRemove(ch.id);
                  await loadAux();
                }}
              >
                Gỡ
              </button>
            </li>
          ))}
        </ul>

        <div className="webhook-setup">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Thêm kênh Webhook (Gói Chuyên nghiệp · Chỉ nhận https:// hoặc http://localhost)
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={whPrivacyAck}
              onChange={(e) => setWhPrivacyAck(e.target.checked)}
            />
            <span>
              Tôi hiểu khi bật Webhook, nội dung bài viết và thông tin liên hệ trích được sẽ rời
              máy tính tới địa chỉ máy chủ tôi cấu hình.
            </span>
          </label>
          <div className="settings-webhook-fields">
            <input
              type="text"
              className="input"
              placeholder="Tên gợi nhớ Webhook"
              value={whName}
              onChange={(e) => setWhName(e.target.value)}
            />
            <input
              type="url"
              className="input"
              placeholder="https://crm.example.com/webhooks/dealsonar"
              value={whUrl}
              onChange={(e) => setWhUrl(e.target.value)}
            />
            <input
              type="password"
              className="input"
              placeholder="Bí mật ký HMAC-SHA256"
              value={whSecret}
              onChange={(e) => setWhSecret(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!whPrivacyAck}
              onClick={async () => {
                try {
                  await api.webhookAdd(whName || "Webhook CRM", whUrl, whSecret || null);
                  setWhName("");
                  setWhUrl("");
                  setWhSecret("");
                  await loadAux();
                  setBanner({ kind: "ok", text: "Đã thêm kênh Webhook." });
                } catch (err) {
                  setBanner({
                    kind: "err",
                    text: err instanceof Error ? err.message : String(err),
                  });
                }
              }}
            >
              + Thêm Webhook
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
