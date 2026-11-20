// 1. AI Provider & Daily Cap (`06-ai-bridge.md §2, §6, §7`)

import React from "react";
import { api } from "../../lib/api";
import type { AiProviderId } from "../../types/ipc";
import type { SettingsScreenModel } from "./useSettingsScreen";
import { Badge, Button, Input, Select } from "../../components/ui";

export const AiSection: React.FC<{ s: SettingsScreenModel }> = ({ s }) => {
  const {
    onSettingsUpdated,
    draft,
    setDraft,
    section,
    mergeSettings,
    setProbes,
    probingAi,
    setProbingAi,
    setCustomFastMode,
    setCustomSmartMode,
    setBanner,
    savePatch,
    activeProvider,
    tierMap,
    activeProbe,
    availableModels,
    hasScannedLocalModels,
    showCustomFastInput,
    showCustomSmartInput,
    fastRecommendedOptions,
    fastOtherOptions,
    smartRecommendedOptions,
    smartOtherOptions,
  } = s;

  return (
    <div className="settings-section" hidden={section!=="ai"}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h3 style={{ marginTop: 0, marginBottom: 4 }}>
          1. Nhà cung cấp CLI AI & Trần hạn mức ngày
        </h3>
        <Badge >
          {probingAi
            ? "Đang quét danh sách model…"
            : hasScannedLocalModels
              ? `✓ Đã tự quét ${availableModels.length} model từ CLI trên máy`
              : `Danh sách ${availableModels.length} model mặc định`}
        </Badge>
      </div>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Lưu ý riêng tư: Nội dung bài viết, tên group và tên hiển thị người đăng được gửi tới CLI
        AI bạn chọn để chấm khớp. ID tài khoản và đường dẫn bài không được gửi.
      </p>

      <div className="settings-fields settings-model-fields">
        <div className="field-group">
          <label className="field-label">CLI AI đang dùng</label>
          <Select
            aria-label="Chọn nhà cung cấp AI"
            value={activeProvider}
            onChange={(e) => {
              const p = e.target.value as AiProviderId;
              setCustomFastMode(false);
              setCustomSmartMode(false);
              setDraft(d => ({ ...d, ai_provider: p }));
            }}
          >
            <option value="claude_cli">Claude Code (`claude`)</option>
            <option value="codex_cli">OpenAI Codex (`codex`)</option>
            <option value="agy_cli">Antigravity (`agy`)</option>
          </Select>
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
          <Select
            aria-label="Chọn mô hình tầng Fast"
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
            <option value="__custom__">Tự nhập tên model khác…</option>
          </Select>
          {showCustomFastInput ? (
            <Input
              type="text"
              aria-label="Nhập tên mô hình tầng Fast tuỳ chỉnh"
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
          <Select
            aria-label="Chọn mô hình tầng Smart"
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
            <option value="__custom__">Tự nhập tên model khác…</option>
          </Select>
          {showCustomSmartInput ? (
            <Input
              type="text"
              aria-label="Nhập tên mô hình tầng Smart tuỳ chỉnh"
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
          <Input
            type="number"
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
        <Button
          variant="primary" size="sm"
          onClick={() =>
            void savePatch({
              ai_provider: activeProvider,
              model_tiers: draft.model_tiers,
              daily_ai_post_cap: draft.daily_ai_post_cap,
            })
          }
        >
          Lưu cấu hình AI
        </Button>
        <Button
          size="sm"
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
        </Button>
        {activeProbe?.recommended_fast_model && activeProbe?.recommended_smart_model && (
          <Button
            size="sm"
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
          </Button>
        )}
      </div>
    </div>
  );
};
