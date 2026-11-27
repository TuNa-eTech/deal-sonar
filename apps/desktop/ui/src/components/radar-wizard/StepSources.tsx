// Step 3: choose source groups.

import React from "react";
import { api } from "../../lib/api";
import { openSafeSetupUrl } from "../../lib/security";
import type { RadarWizardModel } from "./useRadarWizard";
import { Badge, Button, Card, Input } from "../ui";

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
          <Input
            type="search"
            style={{ maxWidth: 340 }}
            placeholder="Tìm group theo tên…"
            value={sourceQuery}
            onChange={(e) => setSourceQuery(e.target.value)}
          />
          <Badge tone="primary">
            Đã chọn {selectedSourceIds.length} group · Tổng theo dõi:{" "}
            {totalSelectedFollowed} / {maxGroups} group (Gói{" "}
            {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"})
          </Badge>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <Button
            onClick={async () => {
              const list = await api.sourceList();
              setSources(list);
            }}
          >
            Làm mới danh sách
          </Button>
          <Button
            onClick={() => openSafeSetupUrl("https://www.facebook.com/groups/joins/")}
          >
            Mở trang group của tôi trên Facebook
          </Button>
        </div>
      </div>

      {filteredSources.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 32 }}>
          <p style={{ marginTop: 0 }}>
            Extension chưa phát hiện group nào hoặc không khớp từ khoá tìm kiếm.
          </p>
          <Button
            variant="primary"
            onClick={() => openSafeSetupUrl("https://www.facebook.com/groups/joins/")}
          >
            Mở trang group của tôi trên Facebook
          </Button>
        </Card>
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
                        disabled={!checked && src.state !== "ok"}
                        onChange={() => toggleSource(src.id)}
                      />
                    </td>
                    <td>
                      <strong>{src.name}</strong>
                      {src.state !== "ok" && <span className="field-hint"> · Chưa kết nối ổn định, chưa dùng được</span>}
                    </td>
                    <td>
                      <Badge >
                        {src.privacy === "private" ? "Group kín" : "Công khai"}
                      </Badge>
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
