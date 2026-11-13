// Radar create/edit wizard: modal shell, stepper, live summary, and footer.

import React from "react";
import { readWorkspace } from "../../lib/workspace";
import { api } from "../../lib/api";
import { StepDescribe } from "./StepDescribe";
import { StepFields } from "./StepFields";
import { StepSources } from "./StepSources";
import { StepPreview } from "./StepPreview";
import { type RadarWizardProps, useRadarWizard } from "./useRadarWizard";

export const RadarWizard: React.FC<RadarWizardProps> = (props) => {
  const w = useRadarWizard(props);
  const {
    editRadar,
    onClose,
    notify,
    hardFilters,
    setHardFilters,
    isEditingActive,
    step,
    setStep,
    setMode,
    radarName,
    description,
    setDescription,
    fields,
    setFields,
    sources,
    selectedSourceIds,
    previewState,
    previewLoading,
    errorMsg,
    setErrorMsg,
    saving,
    previewRunning,
    previewBusy,
    goToStep2,
    goToStep3,
    goToStep4,
    handleSaveRadar,
  } = w;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Trình tạo và sửa Radar">
      <div className="modal-panel radar-studio">
        <div className="modal-header radar-studio-header">
          <div>
            
            <h2 style={{ margin: 0, fontSize: 17 }}>
              {editRadar ? `Chỉnh sửa Radar: ${editRadar.radar.name}` : "Tạo Radar mới"}
            </h2>
            <div className="field-hint">
              Mô tả một lần. Kiểm tra kết quả thật trước khi bật radar.
            </div>
          </div>

            <button type="button" className="radar-close-button" aria-label="Đóng" title="Đóng" disabled={previewLoading || saving} onClick={() => {
              if (previewRunning) {
                void api.radarPreviewCancel(previewState!.radar_id, previewState!.preview_id).then(onClose).catch((err) => setErrorMsg(String(err)));
              } else onClose();
            }}>
              <span className="radar-close-label">Đóng</span><span aria-hidden="true">×</span>
            </button>

          <div className="radar-stepper" aria-label="Các bước tạo radar">
            {[
              { n: 1 as const, label: "1. Mô tả" },
              { n: 2 as const, label: "2. Cách hiểu" },
              { n: 3 as const, label: "3. Nguồn" },
              { n: 4 as const, label: "4. Xem thử và bật" },
            ].map((s) => (
              <button
                key={s.n}
                disabled={previewBusy || saving || s.n>step+1}
                aria-current={step===s.n?"step":undefined}
                type="button"
                className={`btn btn-sm ${step === s.n ? "btn-primary" : ""}`}
                onClick={() => {
                  if(s.n<=step)setStep(s.n);
                  else if(s.n===2)void goToStep2();
                  else if(s.n===3)goToStep3();
                  else void goToStep4();
                }}
              >
                <span className="radar-step-number">{s.n<step?"✓":s.n}</span><span>{s.label.replace(/^\d+\. /, "")}</span>
              </button>
            ))}

          </div>
        </div>

        <div className="radar-studio-workspace">
        <div className="modal-body radar-studio-body">
          <div className="radar-step-intro" aria-live="polite"><h3>{["Bạn đang tìm cơ hội nào?","Kiểm tra cách radar hiểu nhu cầu","Chọn nơi radar tìm bài","Kiểm tra kết quả trước khi bật"][step-1]}</h3><p>{["Chọn mẫu gần với công việc của bạn, rồi mô tả khu vực và nhu cầu cụ thể.","Xác nhận điều kiện bắt buộc. Các thông tin trích xuất đã có sẵn và có thể tùy chỉnh.","Chỉ chọn những nhóm phù hợp. Bạn có thể đổi danh sách này khi chỉnh radar.","Đọc các bài khớp và bị loại, sau đó chọn cách nhận tin phù hợp."][step-1]}</p></div>
          {step===1&&readWorkspace<string>("onboarding-goal","")&&<div className="card"><strong>Nhu cầu đã mô tả</strong><p>{readWorkspace<string>("onboarding-goal","")}</p><button className="btn" onClick={()=>{setDescription(readWorkspace<string>("onboarding-goal",""));setMode("blank");setFields([]);setHardFilters([]);}}>Dùng nhu cầu này và đề xuất bằng AI</button></div>}
          {errorMsg && (
            <div role="alert" className="health-banner danger" style={{ borderRadius: 6, marginBottom: 12 }}>
              <span>{errorMsg}</span>
            </div>
          )}

          {/* STEP 1: MÔ TẢ */}
          {step === 1 && <StepDescribe w={w} />}

          {/* STEP 2: TRƯỜNG */}
          {step === 2 && <StepFields w={w} />}

          {/* STEP 3: NGUỒN */}
          {step === 3 && <StepSources w={w} />}

          {/* STEP 4: XEM THỬ VÀ BẬT */}
          {step === 4 && <StepPreview w={w} />}
        </div>

        <aside className="radar-live-summary" aria-label="Tóm tắt radar đang tạo"><h3>{radarName.trim()||"Radar chưa đặt tên"}</h3><p className="radar-summary-description">{description.trim()||"Mô tả nhu cầu để bắt đầu tìm đúng cơ hội."}</p><dl><div><dt>Thông tin cần lấy</dt><dd>{fields.length} trường</dd></div><div><dt>Điều kiện bắt buộc</dt><dd>{hardFilters.length?`${hardFilters.length} điều kiện`:"Theo mô tả"}</dd></div><div><dt>Nguồn đã chọn</dt><dd>{selectedSourceIds.length} nhóm</dd></div><div><dt>Cách nhận tin</dt><dd>{notify.mode==="digest"?"Gửi gộp":"Báo ngay"}</dd></div></dl>{selectedSourceIds.length>0&&<div className="radar-source-chips">{sources.filter(source=>selectedSourceIds.includes(source.id)).slice(0,3).map(source=><span key={source.id}>{source.name}</span>)}{selectedSourceIds.length>3&&<small>Và {selectedSourceIds.length-3} nhóm khác</small>}</div>}<div className="radar-draft-note"><strong>Bản nháp tự lưu trên máy</strong><p>Chưa áp dụng cho đến khi bạn xác nhận. Xem thử không gửi thông báo.</p></div></aside>
        </div>
        <div className="modal-footer radar-studio-footer">
          <div>
            {step===1&&<span className="field-hint">Bạn có thể đóng và tiếp tục bản nhập sau.</span>}
            {step > 1 && (
              <button
                type="button"
                className="btn"
                disabled={previewBusy || saving}
                onClick={() => setStep((s) => Math.max(1, s - 1) as 1 | 2 | 3 | 4)}
              >
                Quay lại bước {step - 1}
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {step!==4&&<button className="btn" disabled={saving||previewBusy} onClick={onClose}>Lưu bản nhập & Đóng</button>}
            {step === 1 && (
              <button type="button" className="btn btn-primary" onClick={() => void goToStep2()}>
                Tiếp tục: Xác nhận cách hiểu
              </button>
            )}
            {step === 2 && (
              <button type="button" className="btn btn-primary" onClick={goToStep3}>
                Tiếp tục: Chọn nguồn group
              </button>
            )}
            {step === 3 && (
              <button type="button" className="btn btn-primary" onClick={() => void goToStep4()}>
                Tiếp tục: Xem thử trên bài thật
              </button>
            )}
            {step === 4 && (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={saving || previewBusy}
                  onClick={() => void handleSaveRadar(false)}
                >
                  Lưu nháp
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving || previewBusy || previewState?.status!=="done" || !previewState.total_posts}
                  onClick={() => void handleSaveRadar(true)}
                >
                  {isEditingActive ? "Áp dụng & Bật radar" : "Bật radar"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
