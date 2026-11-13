// Step 3: choose source groups.

import React from "react";
import { api } from "../../lib/api";
import { openSafeSetupUrl } from "../../lib/security";
import type { RadarWizardModel } from "./useRadarWizard";

export const StepSources: React.FC<{ w: RadarWizardModel }> = ({ w }) => {
  const {
    license,
    setSources,
    sourceQuery,
    setSourceQuery,
    selectedSourceIds,
    maxGroups,
    toggleSource,
    filteredSources,
    totalSelectedFollowed,
  } = w;

  return (
    <div>
      <div className="toolbar-row" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
          <input
            type="search"
            className="input"
            style={{ maxWidth: 340 }}
            placeholder="Tìm group theo tên…"
            value={sourceQuery}
            onChange={(e) => setSourceQuery(e.target.value)}
          />
          <span className="badge badge-primary">
            Đã chọn {selectedSourceIds.length} group · Tổng theo dõi:{" "}
            {totalSelectedFollowed} / {maxGroups} group (Gói{" "}
            {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"})
          </span>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const list = await api.sourceList();
              setSources(list);
            }}
          >
            Làm mới danh sách
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => openSafeSetupUrl("https://www.facebook.com/groups/joins/")}
          >
            Mở trang group của tôi trên Facebook
          </button>
        </div>
      </div>

      {filteredSources.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 32 }}>
          <p style={{ marginTop: 0 }}>
            Extension chưa phát hiện group nào hoặc không khớp từ khoá tìm kiếm.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => openSafeSetupUrl("https://www.facebook.com/groups/joins/")}
          >
            Mở trang group của tôi trên Facebook
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="crm-table">
            <thead>
              <tr>
                <th style={{ width: 52 }}>Chọn</th>
                <th>Tên Group Facebook</th>
                <th>Loại</th>
                <th>Thành viên</th>
                <th>Bài đã có trong kho</th>
              </tr>
            </thead>
            <tbody>
              {filteredSources.map((src) => {
                const checked = selectedSourceIds.includes(src.id);
                return (
                  <tr key={src.id} onClick={() => toggleSource(src.id)} style={{ cursor: "pointer" }}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Chọn nguồn ${src.name}`}
                        checked={checked}
                        onChange={() => toggleSource(src.id)}
                      />
                    </td>
                    <td>
                      <strong>{src.name}</strong>
                    </td>
                    <td>
                      <span className="badge">
                        {src.privacy === "private" ? "Group kín" : "Công khai"}
                      </span>
                    </td>
                    <td>
                      {src.member_count
                        ? `${src.member_count.toLocaleString("vi-VN")} thành viên`
                        : "—"}
                    </td>
                    <td>{src.stored_post_count.toLocaleString("vi-VN")} bài</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
