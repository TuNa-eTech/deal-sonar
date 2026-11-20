// Radar creation and review.

import React from "react";
import { api } from "../../lib/api";
import { StepDescribe } from "./StepDescribe";
import { StepFields } from "./StepFields";
import { StepSources } from "./StepSources";
import { StepPreview } from "./StepPreview";
import { type RadarWizardProps, useRadarWizard } from "./useRadarWizard";
import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from "../ui";

export const RadarWizard: React.FC<RadarWizardProps> = (props) => {
  const w = useRadarWizard(props);
  const {
    editRadar, onClose, description, selectedSourceIds, sources, sourcesOpen,
    setSourcesOpen, sourcesSuggested, step, setStep, previewState, attachedPreview,
    previewLoading, previewRunning, previewBusy, suggesting, saving, errorMsg,
    setErrorMsg, isEditingActive, preparePreview, handleSaveRadar,
  } = w;
  const reviewing = step === 4;
  const busy = previewBusy || suggesting || saving;
  const selectedSources = sources.filter(source => selectedSourceIds.includes(source.id));

  const close = () => {
    if (previewRunning && !attachedPreview && previewState) {
      void api.radarPreviewCancel(previewState.radar_id, previewState.preview_id)
        .then(onClose).catch(err => setErrorMsg(String(err)));
    } else {
      onClose();
    }
  };

  return (
    <Modal label="Trình tạo và sửa Radar" className="radar-studio radar-ai-wizard">
      <ModalHeader className="radar-studio-header">
        <div>
          <h2>{editRadar ? `Chỉnh sửa Radar: ${editRadar.radar.name}` : "Tạo Radar mới"}</h2>
        </div>
        <button type="button" className="radar-close-button" aria-label="Đóng"
          disabled={previewLoading || suggesting || saving} onClick={close}>
          <span className="radar-close-label">Đóng</span><span aria-hidden="true">×</span>
        </button>
        <nav className="radar-two-stages" aria-label="Các bước tạo Radar">
          <span aria-current={reviewing ? undefined : "step"}><b>1</b> Thiết lập với AI</span>
          <span aria-current={reviewing ? "step" : undefined}><b>2</b> Xem thử và bật</span>
        </nav>
      </ModalHeader>

      <ModalBody className="radar-studio-body">
        {errorMsg && <div role="alert" className="health-banner danger">{errorMsg}</div>}
        {reviewing ? <StepPreview w={w} /> : (
          <fieldset className="radar-ai-setup" disabled={busy}>
            <legend className="radar-setup-title">Bạn muốn tìm gì?</legend>
            <div className="radar-ai-columns">
              <StepDescribe w={w} />
              <section className="radar-ai-criteria" aria-label="AI hiểu nhu cầu của bạn">
                <h3>AI hiểu nhu cầu của bạn</h3>
                {suggesting && <p role="status">Đang phân tích mô tả và kiểm tra các nhóm phù hợp…</p>}
                <StepFields w={w} />
              </section>
            </div>
            <details className="radar-ai-sources" open={sourcesOpen}
              onToggle={event => setSourcesOpen(event.currentTarget.open)}>
              <summary>
                <span>
                  <strong>{selectedSourceIds.length
                    ? `${sourcesSuggested ? "AI đã chọn" : "Đã chọn"} ${selectedSourceIds.length} nhóm Facebook`
                    : "Nguồn Facebook"}</strong>
                  <span className="field-hint">
                    {selectedSources.length ? selectedSources.map(source => source.name).join(" · ")
                      : sources.length ? "AI sẽ tìm nhóm phù hợp khi phân tích mô tả."
                      : "Chưa có nhóm. Mở Facebook để thêm nguồn."}
                  </span>
                </span>
                <span className="radar-source-action">Xem nguồn</span>
              </summary>
              <StepSources w={w} />
            </details>
          </fieldset>
        )}
      </ModalBody>

      <ModalFooter className="radar-studio-footer radar-ai-actions">
        {reviewing ? (
          <>
            <Button disabled={busy} onClick={() => setStep(1)}>Sửa tiêu chí và nguồn</Button>
            <div className="radar-review-actions">
              <Button disabled={busy} onClick={() => void handleSaveRadar(false)}>Giữ bản nháp</Button>
              <Button variant="primary"
                disabled={busy || previewState?.status !== "done" || !previewState.total_posts}
                onClick={() => void handleSaveRadar(true)}>
                {isEditingActive ? "Áp dụng & Bật radar" : "Bật radar"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="field-hint">
              {editRadar ? "Xem thử cấu hình trước khi áp dụng." : "DealSonar lưu bản nháp khi chạy xem thử."}
            </span>
            <div className="radar-review-actions">
              <Button disabled={busy} onClick={onClose}>Lưu bản nhập & Đóng</Button>
              <Button variant="primary" disabled={busy || !description.trim()} onClick={() => void preparePreview()}>
                {suggesting ? "AI đang chuẩn bị…" : "Chạy xem thử"}
              </Button>
            </div>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};
