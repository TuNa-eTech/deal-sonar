// 4. License (`03-desktop.md §5`, `02-radar-spec.md §8`)

import React from "react";
import { api } from "../../lib/api";
import type { SettingsScreenModel } from "./useSettingsScreen";

export const LicenseSection: React.FC<{ s: SettingsScreenModel }> = ({ s }) => {
  const {
    license,
    onLicenseUpdated,
    section,
    licenseInput,
    setLicenseInput,
    setBanner,
  } = s;

  return (
    <div className="settings-section" hidden={section!=="license"}>
      <h3 style={{ marginTop: 0 }}>4. Bản quyền & Giới hạn gói</h3>
      <div style={{ marginBottom: 10 }}>
        Gói hiện tại:{" "}
        <span className="badge badge-primary">
          {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"}
        </span>{" "}
        Giới hạn:{" "}
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
  );
};
