import React, { useEffect, useRef, useState } from "react";
import { readWorkspace, saveWorkspace } from "../lib/workspace";
import {BackupRestore} from "../components/BackupRestore";
import { api } from "../lib/api";
import type {
  AiModelOption,
  AiProviderId,
  Channel,
  LicenseStatus,
  ProbeResult,
  Settings,
} from "../types/ipc";

const FALLBACK_MODELS_BY_PROVIDER: Record<AiProviderId, AiModelOption[]> = {
  claude_cli: [
    {
      id: "haiku",
      label: "haiku — Claude Haiku mới nhất (Nhanh, tiết kiệm)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "sonnet",
      label: "sonnet — Claude Sonnet mới nhất (Cân bằng, thông minh)",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "opus",
      label: "opus — Claude Opus mới nhất (Suy luận sâu)",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5 (claude-haiku-4-5-20251001)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6 (claude-sonnet-4-6)",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "claude-opus-4-6",
      label: "Claude Opus 4.6 (claude-opus-4-6)",
      recommended_tier: "smart",
      source: "builtin",
    },
  ],
  codex_cli: [
    {
      id: "gpt-6-luna",
      label: "GPT-6-Luna (gpt-6-luna) — Nhanh, tiết kiệm",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol (gpt-6.1-sol) — Suy luận & tạo bộ luật",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "codex-mini-latest",
      label: "Codex Mini Latest (codex-mini-latest)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "gpt-5-codex",
      label: "GPT-5 Codex (gpt-5-codex)",
      recommended_tier: "smart",
      source: "builtin",
    },
  ],
  agy_cli: [
    {
      id: "gemini-3.8-flash-medium",
      label: "Gemini 3.8 Flash (Medium) (gemini-3.8-flash-medium)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "gemini-4-carbon-medium",
      label: "Gemini 4 Carbon (Medium) (gemini-4-carbon-medium)",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash (gemini-2.5-flash)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro (gemini-2.5-pro)",
      recommended_tier: "smart",
      source: "builtin",
    },
  ],
};

interface SettingsScreenProps {
  settings: Settings;
  license: LicenseStatus;
  onSettingsUpdated: (s: Settings) => void;
  onLicenseUpdated: (l: LicenseStatus) => void;
  onReopenOnboarding: () => void;
  onAllDataDeleted: () => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  settings,
  license,
  onSettingsUpdated,
  onLicenseUpdated,
  onReopenOnboarding,
  onAllDataDeleted,
}) => {
  const [draft, setDraft] = useState<Settings>(()=>({...settings,...readWorkspace<Partial<Settings>>("settings-draft",{})}));
  const baseline = useRef(settings);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState("ai");
  const mergeSettings = (next:Settings, savedKeys:string[]=[]) => {
    const before=baseline.current;
    setDraft(current=>Object.fromEntries(Object.entries(next).map(([key,value])=>[key, savedKeys.includes(key)||JSON.stringify(current[key as keyof Settings])===JSON.stringify(before[key as keyof Settings])?value:current[key as keyof Settings]])) as unknown as Settings);
    baseline.current=next;
  };
  const dirtyKeys=(Object.keys(draft) as (keyof Settings)[]).filter(k=>JSON.stringify(draft[k])!==JSON.stringify(settings[k]));
  useEffect(()=>{saveWorkspace("settings-draft",Object.fromEntries(dirtyKeys.map(k=>[k,draft[k]])));},[draft,settings]);
  const [probes, setProbes] = useState<Record<AiProviderId, ProbeResult> | null>(null);
  const [probingAi, setProbingAi] = useState(false);
  const [customFastMode, setCustomFastMode] = useState(false);
  const [customSmartMode, setCustomSmartMode] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);

  const [tgToken, setTgToken] = useState("");
  const [whName, setWhName] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  const [whPrivacyAck, setWhPrivacyAck] = useState(false);

  const [licenseInput, setLicenseInput] = useState("");
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [deletePhrase, setDeletePhrase] = useState("");

  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    mergeSettings(settings);
  }, [settings]);

  const loadAux = async () => {
    setProbingAi(true);
    try {
      const [p, ch, refreshedSettings] = await Promise.all([
        api.aiProbe(),
        api.channelList(),
        api.settingsGet(),
      ]);
      setProbes(p);
      setChannels(ch);
      mergeSettings(refreshedSettings);
      onSettingsUpdated(refreshedSettings);
    } finally {
      setProbingAi(false);
    }
  };

  useEffect(() => {
    void loadAux();
  }, []);

  const savePatch = async (patch: Partial<Settings>, msg = "Đã lưu thay đổi cài đặt.") => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await api.settingsSet(patch);
      mergeSettings(updated, Object.keys(patch));
      onSettingsUpdated(updated);
      setBanner({ kind: "ok", text: msg });
    } catch (err) {
      setBanner({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally { setSaving(false); }
  };

  const activeProvider: AiProviderId = draft.ai_provider ?? "claude_cli";
  const tierMap = draft.model_tiers[activeProvider];
  const activeProbe = probes?.[activeProvider];
  const availableModels: AiModelOption[] =
    activeProbe?.available_models && activeProbe.available_models.length > 0
      ? activeProbe.available_models
      : FALLBACK_MODELS_BY_PROVIDER[activeProvider];
  const hasScannedLocalModels = availableModels.some((m) => m.source === "local_cli");

  const fastInCatalog = availableModels.some((m) => m.id === tierMap.fast);
  const smartInCatalog = availableModels.some((m) => m.id === tierMap.smart);
  const showCustomFastInput = customFastMode || !fastInCatalog;
  const showCustomSmartInput = customSmartMode || !smartInCatalog;

  const fastRecommendedOptions = availableModels.filter((m) => m.recommended_tier === "fast");
  const fastOtherOptions = availableModels.filter((m) => m.recommended_tier !== "fast");
  const smartRecommendedOptions = availableModels.filter((m) => m.recommended_tier === "smart");
  const smartOtherOptions = availableModels.filter((m) => m.recommended_tier !== "smart");

  return (
    <div>
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Cài đặt hệ thống</h1>
          <p className="screen-subtitle">
            Cấu hình CLI AI, Telegram & Webhook, tần suất quét an toàn, bản quyền và quản lý dữ liệu
          </p>
        </div>
        <button type="button" className="btn" onClick={onReopenOnboarding}>
          Mở lại trình hướng dẫn cài đặt ban đầu
        </button>
      </div>

      <div className="section-tabs" aria-label="Nhóm cài đặt">{[["ai","AI & Kết nối"],["notifications","Thông báo"],["schedule","Lịch quét"],["license","Gói sử dụng"],["data","Dữ liệu"]].map(([id,label])=><button key={id} className={`btn ${section===id?"btn-primary":""}`} onClick={()=>setSection(id!)} aria-pressed={section===id}>{label}</button>)}</div>
      <div className="draft-status" role="status">{saving?"Đang lưu…":dirtyKeys.length?"Có thay đổi chưa áp dụng. Bản nhập được giữ trên máy khi chuyển mục.":"Tất cả thay đổi đã được lưu."}{dirtyKeys.length>0&&<button className="btn btn-sm" onClick={()=>setDraft(settings)}>Bỏ thay đổi chưa lưu</button>}</div>
      {banner && (
        <div
          className={`health-banner ${banner.kind === "err" ? "danger" : "info"}`}
          style={{ borderRadius: 6, marginBottom: 14 }}
        >
          <span>{banner.text}</span>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* 1. AI Provider & Daily Cap (`06-ai-bridge.md §2, §6, §7`) */}
        <div className="card settings-section" hidden={section!=="ai"}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <h3 style={{ marginTop: 0, marginBottom: 4 }}>
              1. Nhà cung cấp CLI AI & Trần hạn mức ngày
            </h3>
            <span className={`badge ${hasScannedLocalModels ? "badge-success" : "badge-neutral"}`}>
              {probingAi
                ? "Đang quét danh sách model…"
                : hasScannedLocalModels
                  ? `✓ Đã tự quét ${availableModels.length} model từ CLI trên máy`
                  : `Danh sách ${availableModels.length} model mặc định`}
            </span>
          </div>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Lưu ý riêng tư: Nội dung bài viết, tên group và tên hiển thị người đăng được gửi tới CLI
            AI bạn chọn để chấm khớp. ID tài khoản và đường dẫn bài không được gửi.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.35fr 1.35fr 0.8fr", gap: 10 }}>
            <div className="field-group">
              <label className="field-label">CLI AI đang dùng</label>
              <select
                aria-label="Chọn nhà cung cấp AI"
                className="select"
                value={activeProvider}
                onChange={async (e) => {
                  const p = e.target.value as AiProviderId;
                  setCustomFastMode(false);
                  setCustomSmartMode(false);
                  const s = await api.aiSetProvider(p);
                  mergeSettings(s);
                  onSettingsUpdated(s);
                }}
              >
                <option value="claude_cli">Claude Code (`claude`)</option>
                <option value="codex_cli">OpenAI Codex (`codex`)</option>
                <option value="agy_cli">Antigravity (`agy`)</option>
              </select>
              {activeProbe && (
                <span className="field-hint">
                  {activeProbe.installed
                    ? `Đã cài (${activeProbe.version ?? activeProbe.binary_name})`
                    : "Chưa cài trên máy"}
                </span>
              )}
            </div>

            <div className="field-group">
              <label className="field-label">Mô hình tầng Fast (Chấm bài)</label>
              <select
                aria-label="Chọn mô hình tầng Fast"
                className="select"
                value={showCustomFastInput ? "__custom__" : tierMap.fast}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "__custom__") {
                    setCustomFastMode(true);
                    return;
                  }
                  setCustomFastMode(false);
                  setDraft((d) => ({
                    ...d,
                    model_tiers: {
                      ...d.model_tiers,
                      [activeProvider]: { ...tierMap, fast: val },
                    },
                  }));
                }}
              >
                {fastRecommendedOptions.length > 0 && (
                  <optgroup label="★ Khuyến nghị cho tầng Fast (Nhanh & Tiết kiệm)">
                    {fastRecommendedOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {fastOtherOptions.length > 0 && (
                  <optgroup label="Các model khác trên CLI">
                    {fastOtherOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="__custom__">✍️ Tự nhập tên model khác…</option>
              </select>
              {showCustomFastInput ? (
                <input
                  type="text"
                  aria-label="Nhập tên mô hình tầng Fast tuỳ chỉnh"
                  className="input"
                  style={{ marginTop: 6 }}
                  placeholder="Nhập mã model (VD: claude-haiku-4-5)"
                  value={tierMap.fast}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      model_tiers: {
                        ...d.model_tiers,
                        [activeProvider]: { ...tierMap, fast: e.target.value },
                      },
                    }))
                  }
                />
              ) : (
                <span className="field-hint">
                  Mã CLI: <code>{tierMap.fast}</code>
                </span>
              )}
            </div>

            <div className="field-group">
              <label className="field-label">Mô hình tầng Smart (Đề xuất & Bộ luật)</label>
              <select
                aria-label="Chọn mô hình tầng Smart"
                className="select"
                value={showCustomSmartInput ? "__custom__" : tierMap.smart}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "__custom__") {
                    setCustomSmartMode(true);
                    return;
                  }
                  setCustomSmartMode(false);
                  setDraft((d) => ({
                    ...d,
                    model_tiers: {
                      ...d.model_tiers,
                      [activeProvider]: { ...tierMap, smart: val },
                    },
                  }));
                }}
              >
                {smartRecommendedOptions.length > 0 && (
                  <optgroup label="★ Khuyến nghị cho tầng Smart (Suy luận & Bộ luật)">
                    {smartRecommendedOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {smartOtherOptions.length > 0 && (
                  <optgroup label="Các model khác trên CLI">
                    {smartOtherOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="__custom__">✍️ Tự nhập tên model khác…</option>
              </select>
              {showCustomSmartInput ? (
                <input
                  type="text"
                  aria-label="Nhập tên mô hình tầng Smart tuỳ chỉnh"
                  className="input"
                  style={{ marginTop: 6 }}
                  placeholder="Nhập mã model (VD: claude-sonnet-4-6)"
                  value={tierMap.smart}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      model_tiers: {
                        ...d.model_tiers,
                        [activeProvider]: { ...tierMap, smart: e.target.value },
                      },
                    }))
                  }
                />
              ) : (
                <span className="field-hint">
                  Mã CLI: <code>{tierMap.smart}</code>
                </span>
              )}
            </div>

            <div className="field-group">
              <label className="field-label">Số bài tối đa gửi AI / ngày</label>
              <input
                type="number"
                className="input"
                min={50}
                max={20000}
                value={draft.daily_ai_post_cap}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, daily_ai_post_cap: Number(e.target.value) || 2000 }))
                }
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() =>
                void savePatch({
                  ai_provider: activeProvider,
                  model_tiers: draft.model_tiers,
                  daily_ai_post_cap: draft.daily_ai_post_cap,
                })
              }
            >
              Lưu cấu hình AI
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={probingAi}
              onClick={async () => {
                setProbingAi(true);
                try {
                  const p = await api.aiProbe();
                  const s = await api.settingsGet();
                  setProbes(p);
                  setDraft(s);
                  onSettingsUpdated(s);
                  setCustomFastMode(false);
                  setCustomSmartMode(false);
                  const count = p[activeProvider]?.available_models?.length ?? 0;
                  setBanner({
                    kind: "ok",
                    text: `Đã dò lại các CLI AI và quét được ${count} model cho ${p[activeProvider]?.binary_name ?? activeProvider}.`,
                  });
                } finally {
                  setProbingAi(false);
                }
              }}
            >
              {probingAi ? "Đang dò CLI & model…" : "Dò lại CLI & Quét model"}
            </button>
            {activeProbe?.recommended_fast_model && activeProbe?.recommended_smart_model && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const recFast = activeProbe.recommended_fast_model!;
                  const recSmart = activeProbe.recommended_smart_model!;
                  setCustomFastMode(false);
                  setCustomSmartMode(false);
                  setDraft((d) => ({
                    ...d,
                    model_tiers: {
                      ...d.model_tiers,
                      [activeProvider]: { fast: recFast, smart: recSmart },
                    },
                  }));
                }}
              >
                Chọn model khuyến nghị ({activeProbe.recommended_fast_model} /{" "}
                {activeProbe.recommended_smart_model})
              </button>
            )}
          </div>
        </div>

        {/* 2. Telegram & Quiet Hours / Digest (`07-notifications-export.md §2–4`) */}
        <div className="card settings-section" hidden={section!=="notifications"}>
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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 12 }}>
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

            <div className="card" style={{ background: "var(--bg-subtle)", marginTop: 8 }}>
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
              <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 200px auto", gap: 8 }}>
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

        {/* 3. Crawl Policy & Active Hours (`02-extension.md §6.1`) */}
        <div className="card settings-section" hidden={section!=="schedule"}>
          <h3 style={{ marginTop: 0 }}>3. Chính sách tần suất quét & Giờ hoạt động</h3>
          <p className="field-hint">
            Chặn cứng bất biến trong Extension: tối đa tuyệt đối 90 lần tải/giờ, 900 lần/ngày, tối
            thiểu 4 phút/group, tự dừng ngay khi phiên bất thường.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 12 }}>
            <div>
              <label className="field-label">Chu kỳ mỗi group (10–120 phút)</label>
              <input
                type="number"
                className="input"
                min={10}
                max={120}
                value={draft.crawl_policy.group_interval_minutes}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    crawl_policy: {
                      ...d.crawl_policy,
                      group_interval_minutes: Math.min(120, Math.max(10, Number(e.target.value) || 15)),
                    },
                  }))
                }
              />
            </div>
            <div>
              <label className="field-label">Ngân sách tải/giờ (20–90)</label>
              <input
                type="number"
                className="input"
                min={20}
                max={90}
                value={draft.crawl_policy.hourly_page_load_budget}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    crawl_policy: {
                      ...d.crawl_policy,
                      hourly_page_load_budget: Math.min(90, Math.max(20, Number(e.target.value) || 60)),
                    },
                  }))
                }
              />
            </div>
            <div>
              <label className="field-label">Ngân sách tải/ngày (100–900)</label>
              <input
                type="number"
                className="input"
                min={100}
                max={900}
                value={draft.crawl_policy.daily_page_load_budget}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    crawl_policy: {
                      ...d.crawl_policy,
                      daily_page_load_budget: Math.min(900, Math.max(100, Number(e.target.value) || 600)),
                    },
                  }))
                }
              />
            </div>
            <div>
              <label className="field-label">Giờ hoạt động (Từ – Đến)</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="time"
                  className="input"
                  value={draft.crawl_policy.active_hours.from}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      crawl_policy: {
                        ...d.crawl_policy,
                        active_hours: { ...d.crawl_policy.active_hours, from: e.target.value },
                      },
                    }))
                  }
                />
                <input
                  type="time"
                  className="input"
                  value={draft.crawl_policy.active_hours.to}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      crawl_policy: {
                        ...d.crawl_policy,
                        active_hours: { ...d.crawl_policy.active_hours, to: e.target.value },
                      },
                    }))
                  }
                />
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 18, alignItems: "center", marginBottom: 10 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={draft.launch_at_login}
                onChange={(e) => setDraft((d) => ({ ...d, launch_at_login: e.target.checked }))}
              />
              <span>Mở DealSonar cùng máy tính</span>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={draft.crawl_policy.only_when_idle}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    crawl_policy: { ...d.crawl_policy, only_when_idle: e.target.checked },
                  }))
                }
              />
              <span>Chỉ quét khi máy rảnh (idle)</span>
            </label>
          </div>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() =>
              void savePatch({
                launch_at_login: draft.launch_at_login,
                crawl_policy: draft.crawl_policy,
              })
            }
          >
            Lưu chính sách quét
          </button>
        </div>

        {/* 4. License (`03-desktop.md §5`, `02-radar-spec.md §8`) */}
        <div className="card settings-section" hidden={section!=="license"}>
          <h3 style={{ marginTop: 0 }}>4. Bản quyền & Giới hạn gói</h3>
          <div style={{ marginBottom: 10 }}>
            Gói hiện tại:{" "}
            <span className="badge badge-primary">
              {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"}
            </span>{" "}
            — Giới hạn:{" "}
            <strong>
              {license.limits.max_active_radars === null
                ? "Không giới hạn radar"
                : `${license.limits.max_active_radars} radar`}
              , {license.limits.max_followed_groups} group, {license.limits.max_fields_per_radar}{" "}
              trường/radar
            </strong>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              className="input"
              style={{ maxWidth: 420 }}
              placeholder="Nhập khoá bản quyền Ed25519 (ví dụ: DS-PRO-2026-XXXX)…"
              value={licenseInput}
              onChange={(e) => setLicenseInput(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                const updated = await api.licenseSet(licenseInput);
                onLicenseUpdated(updated);
                setBanner({
                  kind: "ok",
                  text: `Đã cập nhật bản quyền: Gói ${
                    updated.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"
                  }.`,
                });
              }}
            >
              Kích hoạt khoá
            </button>
          </div>
        </div>

        {/* 5. Data Retention, Backup, Purge & Delete All (`04-data-model.md §5`, `03-risks-compliance.md §3.3`) */}
        <div className="card settings-section" hidden={section!=="data"}>
          <h3 style={{ marginTop: 0 }}>5. Lưu giữ, Sao lưu & Xoá dữ liệu</h3><BackupRestore/>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <label className="field-label">
              Giữ nội dung bài không khớp (7–90 ngày, mặc định 30):
            </label>
            <input
              type="number"
              className="input"
              style={{ width: 100 }}
              min={7}
              max={90}
              value={draft.unmatched_retention_days}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  unmatched_retention_days: Math.min(90, Math.max(7, Number(e.target.value) || 30)),
                }))
              }
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() =>
                void savePatch({ unmatched_retention_days: draft.unmatched_retention_days })
              }
            >
              Lưu thời hạn giữ
            </button>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const res = await api.dataBackup();
                setBanner({ kind: "ok", text: `Đã sao lưu cơ sở dữ liệu tới: ${res.path}` });
              }}
            >
              💾 Sao lưu cơ sở dữ liệu ngay
            </button>

            <button
              type="button"
              className="btn"
              onClick={async () => {
                const res = await api.dataPurge(draft.unmatched_retention_days);
                setBanner({
                  kind: "ok",
                  text: `Đã dọn ${res.posts_purged} bài quá hạn lưu giữ (giữ lại mã băm lọc trùng).`,
                });
              }}
            >
              🧹 Dọn bài hết hạn ngay
            </button>

            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setDeletePhrase("");
                setDeleteStep(1);
              }}
            >
              🗑 Xoá toàn bộ dữ liệu…
            </button>
          </div>
        </div>
      </div>

      {/* Double-Confirmation Delete All Modal */}
      {deleteStep > 0 && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Xác nhận xoá toàn bộ dữ liệu">
          <div className="modal-panel" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, color: "var(--danger)" }}>
                Xoá toàn bộ dữ liệu trên máy (Bước {deleteStep}/2)
              </h3>
            </div>
            <div className="modal-body">
              {deleteStep === 1 ? (
                <p style={{ margin: 0 }}>
                  Thao tác này sẽ xoá vĩnh viễn file cơ sở dữ liệu SQLite (`dealsonar.db`), toàn bộ
                  radar, tin đã lưu, các bản sao lưu trong `backups/`, nhật ký `logs/` và các token
                  trong Kho khoá hệ điều hành. Không thể hoàn tác!
                </p>
              ) : (
                <div>
                  <p style={{ marginTop: 0 }}>
                    Để xác nhận lần cuối, hãy gõ chính xác cụm chữ in hoa{" "}
                    <code>XOA TOAN BO</code> vào ô bên dưới:
                  </p>
                  <input
                    type="text"
                    aria-label="Nhập cụm từ xác nhận xoá"
                    className="input"
                    placeholder="XOA TOAN BO"
                    value={deletePhrase}
                    onChange={(e) => setDeletePhrase(e.target.value)}
                  />
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setDeleteStep(0)}>
                Huỷ bỏ
              </button>
              {deleteStep === 1 ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setDeleteStep(2)}
                >
                  Tôi hiểu, tiếp tục bước xác nhận cuối →
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={deletePhrase.trim() !== "XOA TOAN BO"}
                  onClick={async () => {
                    await api.dataDeleteAll(deletePhrase.trim());
                    setDeleteStep(0);
                    onAllDataDeleted();
                  }}
                >
                  Xoá vĩnh viễn toàn bộ dữ liệu
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
