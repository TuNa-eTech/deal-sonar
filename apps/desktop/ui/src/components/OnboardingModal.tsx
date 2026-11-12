import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { openSafeSetupUrl } from "../lib/security";
import type {
  AiProviderId,
  ChromeConnectResult,
  HealthStatus,
  ProbeResult,
  Settings,
  TelegramSetupStatus,
} from "../types/ipc";

interface OnboardingModalProps {
  settings: Settings;
  health: HealthStatus | null;
  onComplete: (openRadarWizard: boolean) => void;
  onSettingsUpdated: (s: Settings) => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  settings,
  health,
  onComplete,
  onSettingsUpdated,
}) => {
  const [consentChecked, setConsentChecked] = useState(settings.privacy_consent_accepted);
  const [consentSaved, setConsentSaved] = useState(settings.privacy_consent_accepted);

  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [osTab, setOsTab] = useState<"macos" | "windows" | "linux">("macos");
  const [chromeStatus, setChromeStatus] = useState<ChromeConnectResult | null>(null);
  const [checkingChrome, setCheckingChrome] = useState(false);
  const [customExtId, setCustomExtId] = useState("");
  const [chromeError, setChromeError] = useState<string | null>(null);

  const [probes, setProbes] = useState<Record<AiProviderId, ProbeResult> | null>(null);
  const [probingAi, setProbingAi] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AiProviderId>(
    settings.ai_provider ?? "claude_cli"
  );
  const [aiSkipped, setAiSkipped] = useState(false);

  const [botToken, setBotToken] = useState("");
  const [tgStatus, setTgStatus] = useState<TelegramSetupStatus | null>(null);
  const [tgSkipped, setTgSkipped] = useState(false);
  const [tgMsg, setTgMsg] = useState<string | null>(null);
  const [tgError, setTgError] = useState<string | null>(null);

  const [launchAtLogin, setLaunchAtLogin] = useState(settings.launch_at_login ?? true);

  const runChromeCheck = async (explicitExtId?: string) => {
    setCheckingChrome(true);
    setChromeError(null);
    try {
      const trimmed = (explicitExtId ?? customExtId).trim();
      const res = await api.chromeConnect(
        trimmed ? { extension_id: trimmed } : undefined
      );
      setChromeStatus(res);
    } catch (err) {
      setChromeError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingChrome(false);
    }
  };

  const runAiProbe = async () => {
    setProbingAi(true);
    try {
      const res = await api.aiProbe();
      setProbes(res);
      const ready = (["claude_cli", "codex_cli", "agy_cli"] as AiProviderId[]).find(
        (id) => res[id]?.installed && res[id]?.authenticated
      );
      if (ready) {
        setSelectedProvider(ready);
      }
    } finally {
      setProbingAi(false);
    }
  };

  useEffect(() => {
    if (consentSaved) {
      void runChromeCheck();
      void runAiProbe();
    }
  }, [consentSaved]);

  const handleAcceptConsent = async () => {
    if (!consentChecked) return;
    const updated = await api.settingsSet({ privacy_consent_accepted: true });
    onSettingsUpdated(updated);
    setConsentSaved(true);
  };

  const handleConnectTelegram = async () => {
    setTgError(null);
    setTgMsg(null);
    try {
      const res = await api.telegramSetToken(botToken);
      setTgStatus(res);
      setTgMsg(
        res.waiting_for_start
          ? "Đã kiểm tra token hợp lệ. Hãy bấm mở bot và gửi /start."
          : `Đã kết nối bot @${res.bot_username} thành công!`
      );
    } catch (err) {
      setTgError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSendTestTelegram = async () => {
    setTgError(null);
    try {
      const res = await api.telegramTest();
      setTgMsg(res.message);
    } catch (err) {
      setTgError(err instanceof Error ? err.message : String(err));
    }
  };

  const finishWizard = async (openRadarWizard: boolean) => {
    const updated = await api.settingsSet({
      privacy_consent_accepted: true,
      onboarding_completed: true,
      launch_at_login: launchAtLogin,
      ai_provider: aiSkipped ? null : selectedProvider,
    });
    onSettingsUpdated(updated);
    onComplete(openRadarWizard);
  };

  const chromeOk = Boolean(health?.extension_connected || chromeStatus?.extension_connected);
  const fbOk =
    health?.facebook_session === "ok" || chromeStatus?.facebook_session === "ok";
  const currentProbe = probes?.[selectedProvider];
  const aiOk = Boolean(currentProbe?.installed && currentProbe?.authenticated);
  const tgOk = Boolean(
    (tgStatus && tgStatus.channels.length > 0) || (health?.telegram_channel_count ?? 0) > 0
  );

  // Step 0: Privacy & Facebook Safety Consent Gate (`03-risks-compliance.md §3.3`)
  if (!consentSaved) {
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Đồng ý quyền riêng tư và an toàn">
        <div className="modal-panel" style={{ maxWidth: 680 }}>
          <div className="modal-header">
            <h2 style={{ margin: 0, fontSize: 17 }}>
              Chào mừng tới DealSonar — Nguyên tắc riêng tư & an toàn
            </h2>
          </div>
          <div className="modal-body">
            <p style={{ marginTop: 0 }}>
              Trước khi bắt đầu, vui lòng đọc kỹ cách DealSonar vận hành bằng lời thường để bạn hoàn
              toàn chủ động về dữ liệu và tài khoản của mình:
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
              <div className="card" style={{ background: "var(--bg-subtle)" }}>
                <strong>1. Chỉ đọc tần suất thấp trong group bạn đã tham gia</strong>
                <div className="field-hint" style={{ marginTop: 3 }}>
                  Extension chỉ đọc bài viết mới trong các group bạn chọn theo dõi. Không bao giờ tự
                  đăng bài, bình luận, nhắn tin, thả cảm xúc hay quét danh sách thành viên/trang cá
                  nhân.
                </div>
              </div>
              <div className="card" style={{ background: "var(--bg-subtle)" }}>
                <strong>2. Dữ liệu nằm trên máy tính của bạn (Không máy chủ trung gian)</strong>
                <div className="field-hint" style={{ marginTop: 3 }}>
                  Cơ sở dữ liệu SQLite nằm hoàn toàn trên máy bạn. Bài không khớp tự động xoá nội
                  dung sau 30 ngày, và bạn có nút «Xoá toàn bộ dữ liệu» bất cứ lúc nào trong Cài đặt.
                </div>
              </div>
              <div className="card" style={{ background: "var(--bg-subtle)" }}>
                <strong>3. Dữ liệu chỉ đi tới công cụ của chính bạn</strong>
                <div className="field-hint" style={{ marginTop: 3 }}>
                  Nội dung bài và tên hiển thị người đăng được gửi qua CLI AI cá nhân của bạn
                  (`claude`, `codex`, `agy`) để chấm khớp; tin khớp gửi tới bot Telegram hoặc Webhook
                  do chính bạn tạo.
                </div>
              </div>
              <div className="card" style={{ background: "#fffbeb", borderColor: "#fde68a" }}>
                <strong>4. Rủi ro với tài khoản mạng xã hội & trách nhiệm liên hệ</strong>
                <div className="field-hint" style={{ marginTop: 3, color: "#92400e" }}>
                  Dù quét chậm và tự dừng ngay khi gặp trang xác minh (checkpoint), điều khoản nền
                  tảng hạn chế công cụ tự động. Khuyến nghị không dùng tài khoản duy nhất không thể
                  mất. Bạn cam kết chỉ dùng với group mình là thành viên hợp lệ và tự chịu trách
                  nhiệm về cách liên hệ khách hàng.
                </div>
              </div>
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 9,
                padding: 12,
                border: "1px solid var(--border-strong)",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                Tôi đã đọc, hiểu rõ nguyên tắc lưu trữ dữ liệu, rủi ro tài khoản, và đồng ý với Chính
                sách quyền riêng tư & Điều khoản sử dụng của DealSonar.
              </span>
            </label>
          </div>
          <div className="modal-footer">
            <span className="field-hint">Không thu thập số liệu sử dụng khi chưa bật.</span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!consentChecked}
              onClick={handleAcceptConsent}
            >
              Đồng ý và bắt đầu cài đặt (5 bước)
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Hướng dẫn cài đặt lần đầu">
      <div className="modal-panel" style={{ maxWidth: 820 }}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0, fontSize: 17 }}>Thiết lập lần đầu — Sẵn sàng trong vài phút</h2>
            <div className="field-hint">
              Mỗi bước tự phát hiện trạng thái và tự đánh dấu hoàn tất.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {[
              { n: 1 as const, label: "1. Chrome", done: chromeOk },
              { n: 2 as const, label: "2. Facebook", done: fbOk },
              { n: 3 as const, label: "3. AI CLI", done: aiOk || aiSkipped },
              { n: 4 as const, label: "4. Telegram", done: tgOk || tgSkipped },
              { n: 5 as const, label: "5. Radar đầu tiên", done: false },
            ].map((s) => (
              <button
                key={s.n}
                type="button"
                className={`btn btn-sm ${step === s.n ? "btn-primary" : ""}`}
                onClick={() => setStep(s.n)}
              >
                {s.done ? "✓ " : ""}
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="modal-body">
          {step === 1 && (
            <div>
              <h3 style={{ marginTop: 0 }}>Bước 1: Kết nối Chrome Extension</h3>
              <p>
                App tự động ghi file khai báo Native Messaging Host (`com.dealsonar.host.json`) để
                trò chuyện an toàn với tiện ích Chrome trên máy của bạn.
              </p>
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <span className={`badge ${chromeOk ? "badge-success" : "badge-warning"}`}>
                      {chromeOk ? "✓ Đã kết nối Chrome Extension" : "Đang chờ cài đặt Extension"}
                    </span>
                    {chromeStatus?.manifest_path && (
                      <div className="field-hint" style={{ marginTop: 6 }}>
                        Native host: <code>{chromeStatus.manifest_path}</code>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={checkingChrome}
                    onClick={() => void runChromeCheck()}
                  >
                    {checkingChrome ? "Đang kiểm tra…" : "Kiểm tra lại"}
                  </button>
                </div>
                {chromeError && (
                  <div className="badge badge-danger" style={{ marginTop: 8 }}>
                    {chromeError}
                  </div>
                )}
              </div>

              <div className="card" style={{ marginBottom: 12, background: "var(--bg-subtle)" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Ghép nối ID tiện ích thủ công (tuỳ chọn)
                </div>
                <div className="field-hint" style={{ marginBottom: 8 }}>
                  Nếu bạn nạp bản unpacked từ thư mục khác, dán <strong>ID</strong> hiển thị tại{" "}
                  <code>chrome://extensions</code> (32 ký tự) rồi bấm Ghép nối:
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ví dụ: hkmjpcenjjebhpjicnbpmogidfcbmbjn"
                    value={customExtId}
                    onChange={(e) => setCustomExtId(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={checkingChrome || !customExtId.trim()}
                    onClick={() => void runChromeCheck(customExtId)}
                  >
                    Ghép nối ID
                  </button>
                </div>
              </div>

              <div className="field-group">
                <span className="field-label">Hướng dẫn theo hệ điều hành khi cần kiểm tra thủ công:</span>
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  {(["macos", "windows", "linux"] as const).map((os) => (
                    <button
                      key={os}
                      type="button"
                      className={`btn btn-sm ${osTab === os ? "btn-primary" : ""}`}
                      onClick={() => setOsTab(os)}
                    >
                      {os === "macos" ? "macOS" : os === "windows" ? "Windows" : "Linux"}
                    </button>
                  ))}
                </div>
                <div className="card" style={{ background: "var(--bg-subtle)", fontSize: 12.5 }}>
                  {osTab === "macos" && (
                    <div>
                      Mở Chrome → <code>chrome://extensions</code> → bật <strong>Developer mode</strong>{" "}
                      hoặc cài từ cửa hàng. File khai báo được đặt tự động tại{" "}
                      <code>~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dealsonar.host.json</code>.
                    </div>
                  )}
                  {osTab === "windows" && (
                    <div>
                      Mở Chrome → cài tiện ích DealSonar. Khoá Registry tự động ghi tại{" "}
                      <code>HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dealsonar.host</code>.
                    </div>
                  )}
                  {osTab === "linux" && (
                    <div>
                      Mở Google Chrome → cài tiện ích DealSonar. File khai báo đặt tại{" "}
                      <code>~/.config/google-chrome/NativeMessagingHosts/com.dealsonar.host.json</code>.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h3 style={{ marginTop: 0 }}>Bước 2: Kiểm tra phiên đăng nhập Facebook</h3>
              <p>
                DealSonar đọc bài bằng chính phiên đăng nhập Facebook trong trình duyệt Chrome của
                bạn — không bao giờ hỏi mật khẩu hay đọc cookie.
              </p>
              <div className="card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <span className={`badge ${fbOk ? "badge-success" : "badge-danger"}`}>
                      {fbOk ? "✓ Phiên Facebook đang hoạt động ổn định" : "Chưa đăng nhập Facebook trong Chrome"}
                    </span>
                    <div className="field-hint" style={{ marginTop: 6 }}>
                      Nếu chưa đăng nhập, hãy mở facebook.com trong Chrome, đăng nhập rồi bấm Kiểm tra lại.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => openSafeSetupUrl("https://www.facebook.com")}
                    >
                      Mở facebook.com
                    </button>
                    <button type="button" className="btn btn-primary" onClick={() => void runChromeCheck()}>
                      Kiểm tra lại
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h3 style={{ marginTop: 0 }}>Bước 3: Kết nối CLI AI trên máy</h3>
              <p>
                Chọn một CLI AI bạn đang có (`claude`, `codex`, hoặc `agy`). AI chạy trong hộp cát
                tắt toàn bộ công cụ để chấm bài và trích trường an toàn.
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 12 }}>
                {(["claude_cli", "codex_cli", "agy_cli"] as AiProviderId[]).map((pid) => {
                  const p = probes?.[pid];
                  const ready = Boolean(p?.installed && p?.authenticated);
                  return (
                    <div
                      key={pid}
                      className={`template-card ${selectedProvider === pid ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedProvider(pid);
                        setAiSkipped(false);
                        void api.aiSetProvider(pid);
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <strong>
                          {pid === "claude_cli"
                            ? "Claude Code (claude)"
                            : pid === "codex_cli"
                              ? "OpenAI Codex (codex)"
                              : "Antigravity (agy)"}
                        </strong>
                        <span className={`badge ${ready ? "badge-success" : "badge-warning"}`}>
                          {ready ? "Sẵn sàng" : p?.installed ? "Chưa đăng nhập" : "Chưa cài"}
                        </span>
                      </div>
                      <div className="field-hint">
                        {p?.version ? `Phiên bản ${p.version}` : p?.error ?? "Đang dò…"}
                      </div>
                    </div>
                  );
                })}
              </div>

              {currentProbe && (!currentProbe.installed || !currentProbe.authenticated) && (
                <div className="card" style={{ marginBottom: 12, background: "var(--bg-subtle)" }}>
                  <strong>Lệnh cài đặt và đăng nhập cho {currentProbe.binary_name}:</strong>
                  <pre className="code-snippet" style={{ marginTop: 8, marginBottom: 8 }}>
                    {!currentProbe.installed
                      ? `${currentProbe.install_hint}\n${currentProbe.login_command}`
                      : currentProbe.login_command}
                  </pre>
                  <div className="field-hint">
                    Chạy lệnh trên trong Terminal/PowerShell, sau đó bấm «Thử lại».
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={probingAi}
                  onClick={runAiProbe}
                >
                  {probingAi ? "Đang dò CLI…" : "Thử lại"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAiSkipped(true);
                    setStep(4);
                  }}
                >
                  Bỏ qua (chỉ chạy bộ luật BĐS có sẵn)
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <h3 style={{ marginTop: 0 }}>Bước 4: Nhận thông báo qua Telegram</h3>
              <ol style={{ paddingLeft: 18, lineHeight: 1.7 }}>
                <li>
                  Mở{" "}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => openSafeSetupUrl("https://t.me/BotFather")}
                  >
                    @BotFather trên Telegram
                  </button>
                  , gửi lệnh <code>/newbot</code> và đặt tên cho bot riêng của bạn.
                </li>
                <li>Sao chép chuỗi Bot Token dán vào ô bên dưới:</li>
              </ol>

              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input
                  type="password"
                  className="input"
                  placeholder="123456789:AAHxyz..."
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                />
                <button type="button" className="btn btn-primary" onClick={handleConnectTelegram}>
                  Lưu Token & Kiểm tra
                </button>
              </div>

              {tgStatus && (
                <div className="card" style={{ marginBottom: 10, background: "var(--bg-subtle)" }}>
                  <div>
                    Bot: <strong>@{tgStatus.bot_username}</strong> —{" "}
                    {tgStatus.waiting_for_start
                      ? "Đang chờ bạn bấm Start (/start) trong cuộc trò chuyện với bot…"
                      : "Đã nhận /start và tạo kênh báo thành công!"}
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => openSafeSetupUrl(tgStatus.bot_link)}
                    >
                      Mở @{tgStatus.bot_username}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={handleSendTestTelegram}
                    >
                      Gửi tin thử
                    </button>
                  </div>
                </div>
              )}

              {tgMsg && <div className="badge badge-success" style={{ marginBottom: 8 }}>{tgMsg}</div>}
              {tgError && <div className="badge badge-danger" style={{ marginBottom: 8 }}>{tgError}</div>}

              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="btn" onClick={handleSendTestTelegram}>
                  Gửi tin thử
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setTgSkipped(true);
                    setStep(5);
                  }}
                >
                  Bỏ qua (nhận tin trong app & thông báo hệ điều hành)
                </button>
              </div>
            </div>
          )}

          {step === 5 && (
            <div>
              <h3 style={{ marginTop: 0 }}>Bước 5: Lưu ý vận hành & Tạo radar đầu tiên</h3>
              <div
                className="card"
                style={{
                  background: "#eff6ff",
                  borderColor: "#bfdbfe",
                  marginBottom: 14,
                }}
              >
                <strong style={{ color: "#1e40af" }}>Lưu ý quan trọng khi sử dụng:</strong>
                <p style={{ margin: "6px 0 0", color: "#1e3a8a" }}>
                  Radar chỉ chạy khi máy bật, Chrome mở và DealSonar đang chạy ở khay hệ thống.
                </p>
              </div>

              <label
                className="card"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  marginBottom: 16,
                }}
              >
                <div>
                  <strong>Mở cùng máy tính</strong>
                  <div className="field-hint">
                    Tự động chạy ngầm ở khay hệ thống khi bạn đăng nhập máy tính (khuyến nghị bật).
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={launchAtLogin}
                  onChange={(e) => setLaunchAtLogin(e.target.checked)}
                />
              </label>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void finishWizard(true)}
                >
                  Tạo radar đầu tiên ngay →
                </button>
                <button type="button" className="btn" onClick={() => void finishWizard(false)}>
                  Vào màn hình chính
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn"
            disabled={step === 1}
            onClick={() => setStep((s) => Math.max(1, s - 1) as 1 | 2 | 3 | 4 | 5)}
          >
            ← Quay lại
          </button>
          {step < 5 ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStep((s) => Math.min(5, s + 1) as 1 | 2 | 3 | 4 | 5)}
            >
              Bước tiếp theo →
            </button>
          ) : (
            <span className="field-hint">Hoàn tất thiết lập ban đầu</span>
          )}
        </div>
      </div>
    </div>
  );
};
