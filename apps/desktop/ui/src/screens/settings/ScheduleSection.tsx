// 3. Crawl Policy & Active Hours (`02-extension.md §6.1`)

import React from "react";
import type { SettingsScreenModel } from "./useSettingsScreen";

export const ScheduleSection: React.FC<{ s: SettingsScreenModel }> = ({ s }) => {
  const {
    draft,
    setDraft,
    section,
    savePatch,
  } = s;

  return (
    <div className="settings-section" hidden={section!=="schedule"}>
      <h3 style={{ marginTop: 0 }}>3. Chính sách tần suất quét & Giờ hoạt động</h3>
      <p className="field-hint">
        Chặn cứng bất biến trong Extension: tối đa tuyệt đối 90 lần tải/giờ, 900 lần/ngày, tối
        thiểu 4 phút/group, tự dừng ngay khi phiên bất thường.
      </p>

      <div className="settings-fields">
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

      <div className="settings-toggle-row">
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
  );
};
