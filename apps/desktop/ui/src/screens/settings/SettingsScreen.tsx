// Settings screen: section navigation, draft status, and section panels.

import React from "react";
import { AiSection } from "./AiSection";
import { NotificationsSection } from "./NotificationsSection";
import { ScheduleSection } from "./ScheduleSection";
import { LicenseSection } from "./LicenseSection";
import { DataSection } from "./DataSection";
import { DeleteAllModal } from "./DeleteAllModal";
import { type SettingsScreenProps, useSettingsScreen } from "./useSettingsScreen";

export const SettingsScreen: React.FC<SettingsScreenProps> = (props) => {
  const s = useSettingsScreen(props);
  const {
    settings,
    license,
    onReopenOnboarding,
    setDraft,
    saving,
    section,
    setSection,
    dirtyKeys,
    deleteStep,
    banner,
  } = s;

  return (
    <div className="settings-workspace">
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

      <div className="settings-layout"><nav className="settings-navigation" aria-label="Nhóm cài đặt">{[["ai","AI & Kết nối"],["notifications","Thông báo"],["schedule","Lịch quét"],["license","Gói sử dụng"],["data","Dữ liệu"]].map(([id,label])=><button key={id} className={`btn ${section===id?"btn-primary":""}`} onClick={()=>setSection(id!)} aria-pressed={section===id}>{label}</button>)}</nav><div className="settings-content">
      <div className="draft-status" role="status">{saving?"Đang lưu…":dirtyKeys.length?"Có thay đổi chưa áp dụng. Bản nhập được giữ trên máy khi chuyển mục.":"Tất cả thay đổi đã được lưu."}{dirtyKeys.length>0&&<button className="btn btn-sm" onClick={()=>setDraft(settings)}>Bỏ thay đổi chưa lưu</button>}</div>
      {banner && (
        <div
          className={`health-banner ${banner.kind === "err" ? "danger" : "info"}`}
          style={{ borderRadius: 6, marginBottom: 14 }}
        >
          <span>{banner.text}</span>
        </div>
      )}

      <div className="settings-panels">
        {/* 1. AI Provider & Daily Cap (`06-ai-bridge.md §2, §6, §7`) */}
        <AiSection s={s} />

        {/* 2. Telegram & Quiet Hours / Digest (`07-notifications-export.md §2–4`) */}
        <NotificationsSection s={s} />

        {/* 3. Crawl Policy & Active Hours (`02-extension.md §6.1`) */}
        <ScheduleSection s={s} />

        {/* 4. License (`03-desktop.md §5`, `02-radar-spec.md §8`) */}
        <LicenseSection s={s} />

        {/* 5. Data Retention, Backup, Purge & Delete All (`04-data-model.md §5`, `03-risks-compliance.md §3.3`) */}
        <DataSection s={s} />

      </div>

      </div></div>

      {/* Double-Confirmation Delete All Modal */}
      {deleteStep > 0 && <DeleteAllModal s={s} />}
    </div>
  );
};
