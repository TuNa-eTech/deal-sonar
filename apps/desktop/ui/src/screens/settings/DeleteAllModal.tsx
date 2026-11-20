// Double-confirmation modal for deleting all local data.

import React from "react";
import { api } from "../../lib/api";
import type { SettingsScreenModel } from "./useSettingsScreen";
import { Button, Input, Modal, ModalBody, ModalFooter, ModalHeader } from "../../components/ui";

export const DeleteAllModal: React.FC<{ s: SettingsScreenModel }> = ({ s }) => {
  const {
    onAllDataDeleted,
    deleteStep,
    setDeleteStep,
    deletePhrase,
    setDeletePhrase,
  } = s;

  return (
      <Modal label="Xác nhận xoá toàn bộ dữ liệu" size="sm">
          <ModalHeader>
            <h3 style={{ margin: 0, color: "var(--danger)" }}>
              Xoá toàn bộ dữ liệu trên máy (Bước {deleteStep}/2)
            </h3>
          </ModalHeader>
          <ModalBody>
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
                <Input
                  type="text"
                  aria-label="Nhập cụm từ xác nhận xoá"
                  placeholder="XOA TOAN BO"
                  value={deletePhrase}
                  onChange={(e) => setDeletePhrase(e.target.value)}
                />
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => setDeleteStep(0)}>
              Huỷ bỏ
            </Button>
            {deleteStep === 1 ? (
              <Button
                variant="danger"
                onClick={() => setDeleteStep(2)}
              >
                Tôi hiểu, tiếp tục bước xác nhận cuối
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={deletePhrase.trim() !== "XOA TOAN BO"}
                onClick={async () => {
                  await api.dataDeleteAll(deletePhrase.trim());
                  setDeleteStep(0);
                  onAllDataDeleted();
                }}
              >
                Xoá vĩnh viễn toàn bộ dữ liệu
              </Button>
            )}
          </ModalFooter>
        </Modal>
  );
};
