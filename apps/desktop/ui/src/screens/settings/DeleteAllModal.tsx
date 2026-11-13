// Double-confirmation modal for deleting all local data.

import React from "react";
import { api } from "../../lib/api";
import type { SettingsScreenModel } from "./useSettingsScreen";

export const DeleteAllModal: React.FC<{ s: SettingsScreenModel }> = ({ s }) => {
  const {
    onAllDataDeleted,
    deleteStep,
    setDeleteStep,
    deletePhrase,
    setDeletePhrase,
  } = s;

  return (
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
                Tôi hiểu, tiếp tục bước xác nhận cuối
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
  );
};
