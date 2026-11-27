import { AppIcon } from "./AppIcon";
import React, { useCallback, useEffect, useState } from "react";
import {UndoCenter,clearUndo} from "./components/UndoCenter";
import { useWorkspace, useDialogAccessibility, clearWorkspace, saveWorkspace } from "./lib/workspace";
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
import { Heartbeat, isWatching } from "./components/Heartbeat";
import { GoalOnboarding as OnboardingModal } from "./components/GoalOnboarding";
import { RadarWizard } from "./components/RadarWizard";
import { InboxScreen } from "./screens/InboxScreen";
import { LeadTableScreen } from "./screens/LeadTableScreen";
import { RadarsScreen } from "./screens/RadarsScreen";
import { SourcesScreen } from "./screens/SourcesScreen";
import { ContactsScreen } from "./screens/ContactsScreen";
import { HealthScreen } from "./screens/HealthScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { Button } from "./components/ui";

export type ScreenKey =
  | "inbox"
  | "table"
  | "contacts"
  | "radars"
  | "sources"
  | "settings"
  | "health";

type AreaKey = "leads" | "radars" | "system";

/**
 * Three areas instead of eight screens: work the leads, set up what to hunt, keep the
 * machine running. The first screen of each area is where the sidebar lands.
 */
const AREAS: Record<AreaKey, { label: string; icon: string; screens: Array<{ key: ScreenKey; label: string }> }> = {
  leads: {
    label: "Cơ hội",
    icon: "inbox",
    screens: [
      { key: "inbox", label: "Xử lý tin" },
      { key: "table", label: "Bảng tin" },
      { key: "contacts", label: "Liên hệ" },
    ],
  },
  radars: {
    label: "Radar",
    icon: "radars",
    screens: [
      { key: "radars", label: "Radar" },
      { key: "sources", label: "Group" },
    ],
  },
  system: {
    label: "Cài đặt",
    icon: "settings",
    screens: [
      { key: "settings", label: "Cài đặt" },
      { key: "health", label: "Kết nối" },
    ],
  },
};

const SCREEN_KEYS = Object.values(AREAS).flatMap((a) => a.screens.map((s) => s.key));
const areaOf = (screen: ScreenKey): AreaKey =>
  (Object.keys(AREAS) as AreaKey[]).find((k) => AREAS[k].screens.some((s) => s.key === screen)) ?? "leads";

/** Old links and saved state may still point at the retired "today" screen. */
function resolveScreen(value: string): ScreenKey | null {
  if (value === "settings/notifications") return "settings";
  if (value === "today") {
    saveWorkspace("opportunity-queue", "due");
    return "inbox";
  }
  return (SCREEN_KEYS as string[]).includes(value) ? (value as ScreenKey) : null;
}

export const App: React.FC = () => {
  useDialogAccessibility();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [storedScreen, setScreen] = useWorkspace<ScreenKey>("screen", resolveScreen(location.hash.slice(1)) ?? "inbox");
  const [settingsSection, setSettingsSection] = useState(location.hash === "#settings/notifications" ? "notifications" : "ai");
  const screen = resolveScreen(storedScreen) ?? "inbox";
  const area = areaOf(screen);
  useEffect(() => {
    const onHash = () => {
      const next = resolveScreen(location.hash.slice(1));
      if (next === "settings") setSettingsSection(location.hash === "#settings/notifications" ? "notifications" : "ai");
      if (next) setScreen(next);
    };
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const requested = location.hash.slice(1);
    if (requested !== screen && !(screen === "settings" && requested === "settings/notifications")) location.hash = screen;
  }, [screen]);
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
    goal?: string;
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
        const draftCreated = await onDesktopEvent("radar:draft-created", () => {
          void api.radarList().then(setRadars).catch(() => void loadCoreData());
        });

        if (cancelled) {
          [u1, u2, u3, u4, u5, u6, draftCreated].forEach((fn) => fn());
        } else {
          unsubs.push(u1, u2, u3, u4, u5, u6, draftCreated);
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
        <Button
          variant="primary"
          onClick={() => {
            setBooting(true);
            void loadCoreData();
          }}
        >
          Thử lại
        </Button>
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

  const active = radars.filter(r => r.status === "active");
  const activeRadars = active.length;
  const activeSourceIds = new Set(active.flatMap(r => r.source_ids));
  const followedGroups = sources.filter(s => s.followed && s.state === "ok" && activeSourceIds.has(s.id)).length;
  const healthAllOk = isWatching(health, activeRadars, followedGroups);
  const areaBadge: Record<AreaKey, React.ReactNode> = {
    leads: unreadNewCount > 0 ? <span className="nav-badge" title="Tin chưa đọc" aria-label={`${unreadNewCount} tin chưa đọc`}>{unreadNewCount}</span> : null,
    radars: <span className="nav-badge">{radars.filter((r) => r.status === "active").length}</span>,
    system: <AppIcon name={healthAllOk ? "check" : "alert"} className={`connection-indicator ${healthAllOk ? "ok" : "err"}`} />,
  };

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
          <Button
            variant="primary" block
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
          </Button>
        </div>

        <nav className="sidebar-nav">
          {(Object.keys(AREAS) as AreaKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`nav-item ${area === key ? "active" : ""}`}
              aria-current={area === key ? "page" : undefined}
              onClick={() => setScreen(AREAS[key].screens[0]!.key)}
            >
              <span className="nav-label">
                <AppIcon name={AREAS[key].icon} />
                {AREAS[key].label}
              </span>
              {areaBadge[key]}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-local"><AppIcon name="device" /> Dữ liệu chỉ lưu trên máy này</div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-area">
        <div className="workspace-bar">
          <Button className="navigation-toggle" aria-label="Mở điều hướng" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(!navigationOpen)}><AppIcon name="menu" /></Button>
          <div className="area-tabs" role="tablist" aria-label={AREAS[area].label} onKeyDown={event => {
            const tabs = AREAS[area].screens;
            const current = tabs.findIndex(tab => tab.key === screen);
            const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            const index = direction ? (current + direction + tabs.length) % tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (index === null) return;
            event.preventDefault();
            setScreen(tabs[index]!.key);
            event.currentTarget.querySelectorAll("button")[index]?.focus();
          }}>
            {AREAS[area].screens.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                id={`tab-${s.key}`}
                aria-controls="workspace-panel"
                tabIndex={screen === s.key ? 0 : -1}
                aria-selected={screen === s.key}
                className={`area-tab ${screen === s.key ? "active" : ""}`}
                onClick={() => setScreen(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <Heartbeat health={health} followedGroups={followedGroups} activeRadars={activeRadars} onOpen={() => setScreen("health")} />
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
          onOpenHealth={() => setScreen("health")}
        />

        <main className={`screen-scroll screen-${screen}`}><div role="tabpanel" id="workspace-panel" aria-labelledby={`tab-${screen}`}>
          {screen === "inbox" && (
            <InboxScreen
              radars={radars}
              templates={templates}
              health={health}
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
              key={settingsSection}
              initialSection={settingsSection}
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
        </div></main>
      </div>

      {/* First-Run Privacy Consent & 5-Step Onboarding Wizard */}
      {onboardingOpen && (
        <OnboardingModal
          settings={settings}
          health={health}
          onSettingsUpdated={setSettings}
          onComplete={(openWizard, goal) => {
            setOnboardingOpen(false);
            if (openWizard) {
              setWizardState({
                open: true,
                template: null,
                goal,
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
          initialGoal={wizardState.goal}
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
          onRadarChanged={() => {
            setRefreshToken((n) => n + 1);
            void loadCoreData();
          }}
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
