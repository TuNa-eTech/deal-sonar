// 5. Data Retention, Backup, Purge & Delete All (`04-data-model.md §5`, `03-risks-compliance.md §3.3`)

import React from "react";
import { BackupRestore } from "../../components/BackupRestore";
import { api } from "../../lib/api";
import type { SettingsScreenModel } from "./useSettingsScreen";

export const DataSection: React.FC<{ s: SettingsScreenModel }> = ({ s }) => {
  const {
    draft,
    setDraft,
    section,
    setDeleteStep,
    setDeletePhrase,
    setBanner,
    savePatch,
  } = s;

  return (
    <div className="settings-section" hidden={section!=="data"}>
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
          Sao lưu cơ sở dữ liệu ngay
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
          Dọn bài hết hạn ngay
        </button>

        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setDeletePhrase("");
            setDeleteStep(1);
          }}
        >
          Xoá toàn bộ dữ liệu…
        </button>
      </div>
    </div>
  );
};
