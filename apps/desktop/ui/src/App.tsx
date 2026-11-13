import { AppIcon } from "./AppIcon";
import React, { useCallback, useEffect, useState } from "react";
import {UndoCenter,clearUndo} from "./components/UndoCenter";
import { TodayScreen } from "./screens/TodayScreen";
import { useWorkspace, useDialogAccessibility, clearWorkspace } from "./lib/workspace";
import { api, onDesktopEvent } from "./lib/api";
import type {
  HealthStatus,
  LicenseStatus,
  Radar,
  RadarDetail,
  RadarTemplate,
  Settings,
  Source,
} from "./types/ipc";
import { GlobalHealthBanner } from "./components/GlobalHealthBanner";
import { GoalOnboarding as OnboardingModal } from "./components/GoalOnboarding";
import { RadarWizard } from "./components/RadarWizard";
import { InboxScreen } from "./screens/InboxScreen";
import { LeadTableScreen } from "./screens/LeadTableScreen";
import { RadarsScreen } from "./screens/RadarsScreen";
import { SourcesScreen } from "./screens/SourcesScreen";
import { ContactsScreen } from "./screens/ContactsScreen";
import { HealthScreen } from "./screens/HealthScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export type ScreenKey =
  | "today"
  | "inbox"
  | "table"
  | "radars"
  | "sources"
  | "contacts"
  | "health"
  | "settings";

export const App: React.FC = () => {
  useDialogAccessibility();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [screen, setScreen] = useWorkspace<ScreenKey>("screen", "today");
  useEffect(()=>{const onHash=()=>{const v=location.hash.slice(1);if(["today","inbox","table","radars","sources","contacts","health","settings"].includes(v))setScreen(v as ScreenKey);};window.addEventListener("hashchange",onHash);onHash();return()=>window.removeEventListener("hashchange",onHash);},[]);
  useEffect(()=>{if(location.hash.slice(1)!==screen)location.hash=screen;},[screen]);
  useEffect(() => setNavigationOpen(false), [screen]);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [templates, setTemplates] = useState<RadarTemplate[]>([]);
  const [radars, setRadars] = useState<Radar[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [unreadNewCount, setUnreadNewCount] = useState<number>(0);

  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [wizardState, setWizardState] = useState<{
    open: boolean;
    template: RadarTemplate | null;
    editRadar: RadarDetail | null;
    initialStep: 1 | 2 | 3 | 4;
  }>({
    open: false,
    template: null,
    editRadar: null,
    initialStep: 1,
  });

  const [refreshToken, setRefreshToken] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 4000);
  };

  const loadCoreData = useCallback(async () => {
    try {
      setBootError(null);
      const [st, lic, hl, tpls, rds, srcs, newLeads] = await Promise.all([
        api.settingsGet(),
        api.licenseGet(),
        api.healthGet(),
        api.templateList(),
        api.radarList(),
        api.sourceList(),
        api.leadList({ unread_only: true, include_weak:true, limit: 1 }),
      ]);
      setSettings(st);
      setLicense(lic);
      setHealth(hl);
      setTemplates(tpls);
      setRadars(rds);
      setSources(srcs);
      setUnreadNewCount(newLeads.total);
      if (!st.onboarding_completed || !st.privacy_consent_accepted) {
        setOnboardingOpen(true);
      }
      setBooting(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[DealSonar] Lỗi khởi tạo dữ liệu giao diện:", err);
      setBootError(msg);
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    void loadCoreData();
  }, [loadCoreData]);

  // Subscribe to all real-time Tauri push events (`03-desktop.md §4`)
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    const bind = async () => {
      try {
        const u1 = await onDesktopEvent("lead:new", (lead) => {
          showToast(`Tin mới [${lead.radar_name}]: ${lead.summary}`);
          setRefreshToken((n) => n + 1);
          void loadCoreData();
        });
        const u2 = await onDesktopEvent("lead:updated", () => {
          setRefreshToken((n) => n + 1);
          void loadCoreData();
        });
        const u3 = await onDesktopEvent("health:changed", (hl) => {
          setHealth(hl);
        });
        const u4 = await onDesktopEvent("crawl:finished", () => {
          void api.sourceList().then(setSources);
        });
        const u6 = await onDesktopEvent("lead:reminder", (lead)=>{showToast(`Đến hạn liên hệ: ${lead.summary}`);setRefreshToken(n=>n+1);});
        const u5 = await onDesktopEvent("job:failed", (ev) => {
          showToast(`Công việc nền lỗi (${ev.kind}): ${ev.error}`);
        });

        if (cancelled) {
          [u1, u2, u3, u4, u5, u6].forEach((fn) => fn());
        } else {
          unsubs.push(u1, u2, u3, u4, u5, u6);
        }
      } catch (err) {
        console.error("[DealSonar] Không thể đăng ký nhận sự kiện thời gian thực:", err);
      }
    };

    void bind();
    return () => {
      cancelled = true;
      unsubs.forEach((fn) => fn());
    };
  }, [loadCoreData]);

  if (bootError && (!settings || !license)) {
    return (
      <div style={{ padding: 32 }}>
        <h2 style={{ marginBottom: 8 }}>Không thể khởi động giao diện DealSonar</h2>
        <p className="text-muted" style={{ marginBottom: 16 }}>
          {bootError}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setBooting(true);
            void loadCoreData();
          }}
        >
          Thử lại
        </button>
      </div>
    );
  }

  if (booting || !settings || !license) {
    return (
      <div style={{ padding: 32 }} className="text-muted">
        Đang khởi động DealSonar…
      </div>
    );
  }

  const healthAllOk =
    Boolean(health?.extension_connected) &&
    health?.facebook_session === "ok" && health?.automatic_scanning===true && !health?.crawl_paused &&
    (health?.ai_state === "ok" || health?.ai_state === "not_configured");

  return (
    <div className="app-shell">
      {/* Fixed Left Sidebar (`03-ux-flows.md §3`) */}
      <aside className={`sidebar ${navigationOpen ? "navigation-open" : ""}`} aria-label="Điều hướng chính">
        <div className="sidebar-brand">
          <div className="sidebar-brand-title">
            <AppIcon name="radar" className="brand-mark" />
            <span>DealSonar</span>
          </div>
          <span className="nav-badge">
            {license.plan === "pro" ? "Pro" : "Cá nhân"}
          </span>
        </div>

        <div className="sidebar-cta">
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() =>
              setWizardState({
                open: true,
                template: null,
                editRadar: null,
                initialStep: 1,
              })
            }
          >
            + Tạo radar
          </button>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">Làm việc</div>
          <button type="button" className={`nav-item ${screen==="today"?"active":""}`} aria-current={screen==="today"?"page":undefined} onClick={()=>setScreen("today")}><span className="nav-label"><AppIcon name="today" />Hôm nay</span></button>
          <button
            type="button"
            className={`nav-item ${(screen === "inbox" || screen === "table") ? "active" : ""}`}
            aria-current={screen === "inbox" ? "page" : undefined}
            onClick={() => setScreen("inbox")}
          >
            <span className="nav-label"><AppIcon name="inbox" />Cơ hội</span>
            {unreadNewCount > 0 && <span className="nav-badge">{unreadNewCount}</span>}
          </button>

          <div className="nav-section-label">Thiết lập tìm tin</div>
          <button
            type="button"
            className={`nav-item ${screen === "radars" ? "active" : ""}`}
            aria-current={screen === "radars" ? "page" : undefined}
            onClick={() => setScreen("radars")}
          >
            <span className="nav-label"><AppIcon name="radars" />Radar</span>
            <span className="nav-badge">{radars.length}</span>
          </button>

          <button
            type="button"
            className={`nav-item ${screen === "sources" ? "active" : ""}`}
            aria-current={screen === "sources" ? "page" : undefined}
            onClick={() => setScreen("sources")}
          >
            <span className="nav-label"><AppIcon name="sources" />Nguồn</span>
            <span className="nav-badge">{sources.filter((s) => s.followed).length}</span>
          </button>

          <button
            type="button"
            className={`nav-item ${screen === "contacts" ? "active" : ""}`}
            aria-current={screen === "contacts" ? "page" : undefined}
            onClick={() => setScreen("contacts")}
          >
            <span className="nav-label"><AppIcon name="contacts" />Liên hệ</span>
          </button>

          <button
            type="button"
            className={`nav-item ${screen === "health" ? "active" : ""}`}
            aria-current={screen === "health" ? "page" : undefined}
            onClick={() => setScreen("health")}
          >
            <span className="nav-label"><AppIcon name="health" />Kết nối</span>
            <AppIcon name={healthAllOk ? "check" : "alert"} className={`connection-indicator ${healthAllOk ? "ok" : "err"}`} />
          </button>

          <button
            type="button"
            className={`nav-item ${screen === "settings" ? "active" : ""}`}
            aria-current={screen === "settings" ? "page" : undefined}
            onClick={() => setScreen("settings")}
          >
            <span className="nav-label"><AppIcon name="settings" />Cài đặt</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div>
            Đã bật:{" "}
            <strong className="sidebar-active-count">
              {radars.filter((r) => r.status === "active").length} radar
            </strong>
          </div>
          <div>Dữ liệu lưu trên máy. AI và kênh gửi theo cấu hình.</div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-area">
        <div className="workspace-bar">
          <button type="button" className="btn navigation-toggle" aria-label="Mở điều hướng" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(!navigationOpen)}><AppIcon name="menu" /></button>
          <span className="workspace-path">DealSonar <span aria-hidden="true">/</span> <strong>{{today:"Hôm nay",inbox:"Cơ hội",table:"Bảng tin",radars:"Radar",sources:"Nguồn",contacts:"Liên hệ",health:"Kết nối",settings:"Cài đặt"}[screen]}</strong></span>
          <span className="workspace-local"><AppIcon name="device" /> Dữ liệu trên máy</span>
        </div>
        <GlobalHealthBanner
          health={health}
          onRetryConnect={async () => {
            await api.chromeConnect();
            const hl = await api.healthGet();
            setHealth(hl);
          }}
          onRetryAi={async()=>{await api.aiProbe();setHealth(await api.healthGet());}}
          onResumeCrawl={async () => {
            await api.chromeConnect({ resume_crawl: true });
            const hl = await api.healthGet();
            setHealth(hl);
          }}
          onOpenRadars={() => setScreen("radars")}
        />

        <main className={`screen-scroll screen-${screen}`}>
          {(screen==="inbox"||screen==="table")&&<div className="section-tabs" aria-label="Cách xem cơ hội"><button className={`btn ${screen==="inbox"?"btn-primary":""}`} onClick={()=>setScreen("inbox")} aria-pressed={screen==="inbox"}>Danh sách</button><button className={`btn ${screen==="table"?"btn-primary":""}`} onClick={()=>setScreen("table")} aria-pressed={screen==="table"}>Bảng tin</button></div>}
          {screen==="today"&&<TodayScreen health={health} radars={radars} sources={sources} refreshToken={refreshToken} onOpenOpportunities={()=>setScreen("inbox")} onDiagnose={()=>setScreen("health")} onCreateRadar={()=>setWizardState({open:true,template:null,editRadar:null,initialStep:1})} onUpdated={()=>void loadCoreData()}/> }
          {screen === "inbox" && (
            <InboxScreen
              radars={radars}
              templates={templates}
              refreshToken={refreshToken}
              onCreateRadarFromTemplate={(tpl) =>
                setWizardState({
                  open: true,
                  template: tpl,
                  editRadar: null,
                  initialStep: 1,
                })
              }
              onLeadChanged={() => void loadCoreData()}
            />
          )}

          {screen === "table" && (
            <LeadTableScreen
              radars={radars}
              license={license}
              refreshToken={refreshToken}
              onLeadChanged={() => void loadCoreData()}
            />
          )}

          {screen === "radars" && (
            <RadarsScreen
              radars={radars}
              license={license}
              onCreateNew={() =>
                setWizardState({
                  open: true,
                  template: null,
                  editRadar: null,
                  initialStep: 1,
                })
              }
              onEditRadar={(detail, step = 1) =>
                setWizardState({
                  open: true,
                  template: null,
                  editRadar: detail,
                  initialStep: step,
                })
              }
              onChanged={() => void loadCoreData()}
            />
          )}

          {screen === "sources" && (
            <SourcesScreen
              sources={sources}
              license={license}
              onChanged={() => void loadCoreData()}
            />
          )}

          {screen === "contacts" && <ContactsScreen radars={radars} />}

          {screen === "health" && (
            <HealthScreen
              health={health}
              onRefreshHealth={async () => {
                const hl = await api.healthGet();
                setHealth(hl);
              }}
            />
          )}

          {screen === "settings" && (
            <SettingsScreen
              settings={settings}
              license={license}
              onSettingsUpdated={setSettings}
              onLicenseUpdated={setLicense}
              onReopenOnboarding={() => setOnboardingOpen(true)}
              onAllDataDeleted={() => {
                clearWorkspace();clearUndo();
                setScreen("inbox");
                void loadCoreData();
              }}
            />
          )}
        </main>
      </div>

      {/* First-Run Privacy Consent & 5-Step Onboarding Wizard */}
      {onboardingOpen && (
        <OnboardingModal
          settings={settings}
          health={health}
          onSettingsUpdated={setSettings}
          onComplete={(openWizard) => {
            setOnboardingOpen(false);
            if (openWizard) {
              setWizardState({
                open: true,
                template: templates[0] ?? null,
                editRadar: null,
                initialStep: 1,
              });
            }
            void loadCoreData();
          }}
        />
      )}

      {/* 4-Step Radar Creation & Edit Wizard */}
      {wizardState.open && (
        <RadarWizard
          templates={templates}
          sources={sources}
          license={license}
          initialTemplate={wizardState.template}
          editRadar={wizardState.editRadar}
          initialStep={wizardState.initialStep}
          onClose={() =>
            setWizardState({
              open: false,
              template: null,
              editRadar: null,
              initialStep: 1,
            })
          }
          onSaved={() => {
            setScreen("radars");
            setWizardState({
              open: false,
              template: null,
              editRadar: null,
              initialStep: 1,
            });
            setRefreshToken((n) => n + 1);
            void loadCoreData();
          }}
        />
      )}

      <UndoCenter/>
      {toast && <div role="status" className="toast-banner">{toast}</div>}
    </div>
  );
};
