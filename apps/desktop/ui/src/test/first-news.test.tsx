import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalOnboarding } from "../components/GoalOnboarding";
import { NewsFlowStatus } from "../components/NewsFlowStatus";
import { api } from "../lib/api";
import { explainNoNews, formatDuration, journeySteps } from "../lib/newsFlow";
import { evaluateSetup, nextSetupCheck } from "../lib/setupChecks";
import { saveWorkspace } from "../lib/workspace";
import type { FirstNewsStatus, HealthStatus } from "../types/ipc";

afterEach(() => vi.restoreAllMocks());

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

function status(patch: Partial<FirstNewsStatus> = {}): FirstNewsStatus {
  return {
    installed_at: NOW - 120 * MINUTE, installed_at_estimated: false,
    first_radar_activated_at: null, first_followed_source_at: null, first_radar_created_at: null,
    first_post_captured_at: null, first_lead_at: null, first_delivery_at: null,
    active_radars: 1, active_sources: 1, posts_captured: 0, last_post_captured_at: null,
    evaluated_match: 0, evaluated_no_match: 0, waiting_ai: 0, last_evaluated_at: null,
    leads_total: 0, last_lead_at: null, delivery_pending: 0, delivery_failed: 0,
    last_delivery_at: null, last_delivery_error: null, checked_at: NOW, ...patch,
  };
}

async function health(patch: Partial<HealthStatus> = {}): Promise<HealthStatus> {
  return { ...(await api.healthGet()), automatic_scanning: true, extension_connected: true,
    facebook_session: "ok", crawl_paused: false, ai_state: "ok", pending_ai_posts: 0, ...patch };
}

const byId = (report: ReturnType<typeof explainNoNews>, id: string) => report.stages.find(stage => stage.id === id)!;

describe("why no news yet", () => {
  it("separates not collected, collected without a match, waiting for AI and delivery failure", async () => {
    const h = await health({ last_crawl_at: null });
    const notCollected = explainNoNews(status(), h, NOW);
    expect(notCollected.primary).toBe("not_collected");
    expect(byId(notCollected, "not_collected").active).toBe(true);
    expect(byId(notCollected, "no_match").active).toBe(false);
    expect(byId(notCollected, "not_collected").lastSuccess).toBe("Chưa có lần thu bài thành công");
    expect(byId(notCollected, "not_collected").next).toEqual({ label: "Quét ngay trong Nguồn", hash: "sources" });

    const noMatch = explainNoNews(status({
      posts_captured: 40, evaluated_no_match: 40, last_evaluated_at: NOW - 5 * MINUTE,
    }), h, NOW);
    expect(noMatch.primary).toBe("no_match");
    expect(byId(noMatch, "no_match").summary).toContain("Đã đọc 40 bài, chưa bài nào khớp");
    expect(byId(noMatch, "no_match").lastSuccessAt).toBe(NOW - 5 * MINUTE);
    expect(byId(noMatch, "no_match").next?.hash).toBe("inbox");
    expect(byId(noMatch, "not_collected").active).toBe(false);

    const waiting = explainNoNews(status({ posts_captured: 12, waiting_ai: 12 }),
      { ...h, ai_state: "error" }, NOW);
    expect(waiting.primary).toBe("waiting_ai");
    expect(byId(waiting, "waiting_ai").summary).toContain("12 bài đang chờ AI");
    expect(byId(waiting, "waiting_ai").next).toEqual({ label: "Mở cấu hình AI", hash: "settings" });

    const failed = explainNoNews(status({
      posts_captured: 20, evaluated_match: 2, leads_total: 2, last_lead_at: NOW - MINUTE,
      delivery_failed: 2, last_delivery_at: NOW - 90 * MINUTE, last_delivery_error: "Bot bị chặn",
    }), h, NOW);
    expect(failed.primary).toBe("delivery_failed");
    expect(byId(failed, "delivery_failed").summary).toContain("Bot bị chặn");
    expect(byId(failed, "delivery_failed").lastSuccessAt).toBe(NOW - 90 * MINUTE);
    expect(byId(failed, "delivery_failed").next?.hash).toBe("settings/notifications");
    expect(byId(failed, "no_match").active).toBe(false);
  });

  it("blames the connection that is actually broken when nothing was collected", async () => {
    const h = await health();
    expect(byId(explainNoNews(status(), { ...h, extension_connected: false }, NOW), "not_collected").summary).toMatch(/Chrome/);
    expect(byId(explainNoNews(status(), { ...h, facebook_session: "checkpoint" }, NOW), "not_collected").summary).toMatch(/Facebook/);
    expect(byId(explainNoNews(status(), { ...h, automatic_scanning: false }, NOW), "not_collected").summary).toMatch(/Quét tự động đang tắt/);
    expect(byId(explainNoNews(status({ active_sources: 0 }), h, NOW), "not_collected").next?.hash).toBe("radars");
  });

  it("says plainly when there is no active Radar or the lead already arrived", async () => {
    const h = await health();
    expect(explainNoNews(status({ active_radars: 0 }), h, NOW).primary).toBe("no_radar");
    const ok = explainNoNews(status({ posts_captured: 9, leads_total: 1, last_lead_at: NOW - 3 * MINUTE }), h, NOW);
    expect(ok.primary).toBe("has_leads");
    expect(ok.tone).toBe("ok");
  });

  it("keeps install time apart from Radar creation time", () => {
    const steps = journeySteps(status({
      installed_at: NOW - 3 * 24 * 60 * MINUTE,
      first_followed_source_at: NOW - 3 * 24 * 60 * MINUTE + 10 * MINUTE,
      first_radar_created_at: NOW - 40 * MINUTE,
      first_radar_activated_at: NOW - 30 * MINUTE,
      first_lead_at: NOW - 20 * MINUTE,
    }));
    const lead = steps.find(step => step.id === "first_lead")!;
    expect(lead.sinceRadarCreatedMs).toBe(20 * MINUTE);
    expect(lead.sinceInstallMs).toBe(3 * 24 * 60 * MINUTE - 20 * MINUTE);
    expect(lead.sinceInstallMs).not.toBe(lead.sinceRadarCreatedMs);
    expect(steps.find(step => step.id === "installed")!.sinceRadarCreatedMs).toBeNull();
    expect(steps.find(step => step.id === "first_delivery")!.at).toBeNull();
    expect(formatDuration(20 * MINUTE)).toBe("20 phút");
    expect(formatDuration(75 * MINUTE)).toBe("1 giờ 15 phút");
  });

  it("renders the four situations separately with last success and next action", async () => {
    const h = await health();
    vi.spyOn(api, "firstNewsStatus").mockResolvedValue(status({
      posts_captured: 30, evaluated_no_match: 30, delivery_failed: 1, last_delivery_error: "Mất kết nối Telegram",
      first_radar_created_at: NOW - 40 * MINUTE, first_lead_at: NOW - 10 * MINUTE,
    }));
    render(<NewsFlowStatus health={h} />);
    const region = await screen.findByRole("region", { name: "Vì sao chưa có tin" });
    for (const id of ["not_collected", "no_match", "waiting_ai", "delivery_failed"]) {
      expect(region.querySelector(`[data-stage="${id}"]`)).not.toBeNull();
    }
    const failed = region.querySelector('[data-stage="delivery_failed"]') as HTMLElement;
    expect(failed.dataset.active).toBe("true");
    expect(within(failed).getByText(/Lần thành công gần nhất: Chưa gửi được tin nào/)).toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Kiểm tra kênh nhận" })).toBeInTheDocument();
    expect((region.querySelector('[data-stage="not_collected"]') as HTMLElement).dataset.active).toBe("false");
    const lead = region.querySelector('[data-step="first_lead"]') as HTMLElement;
    expect(lead.textContent).toMatch(/sau khi cài/);
    expect(lead.textContent).toMatch(/sau khi tạo Radar/);
  });
});

describe("first-run connection checks", () => {
  it("judges each connection on its own and points at the next one to fix", async () => {
    const h = await health({ automatic_scanning: false });
    const probe = { installed: true, authenticated: true } as never;
    const checks = evaluateSetup({ health: h, extension: true, facebookOk: true, probe, probed: true });
    expect(checks.map(check => [check.id, check.state])).toEqual([
      ["chrome", "ok"], ["facebook", "ok"], ["ai", "ok"], ["scanning", "problem"], ["channel", "ok"],
    ]);
    expect(nextSetupCheck(checks)?.id).toBe("scanning");
    const noChrome = evaluateSetup({ health: h, extension: false, facebookOk: false, probe: null, probed: false });
    expect(nextSetupCheck(noChrome)?.id).toBe("chrome");
    expect(noChrome.find(check => check.id === "facebook")?.state).toBe("unknown");
    expect(noChrome.find(check => check.id === "channel")?.required).toBe(false);
  });

  it("re-checks one connection, then moves on to the next, and resumes where the user left off", async () => {
    const user = userEvent.setup();
    const settings = { ...(await api.settingsGet()), privacy_consent_accepted: true, onboarding_completed: false };
    saveWorkspace("onboarding-goal", "Khách cần thuê căn hộ");
    saveWorkspace("onboarding-step", 2);
    const off = await health({ automatic_scanning: false });
    const healthGet = vi.spyOn(api, "healthGet").mockResolvedValue(off);
    const chrome = vi.spyOn(api, "chromeConnect");
    const probe = vi.spyOn(api, "aiProbe");
    await act(async () => {
      render(<GoalOnboarding settings={settings} health={off} onSettingsUpdated={vi.fn()} onComplete={vi.fn()} />);
    });
    const dialog = screen.getByRole("dialog", { name: /Hướng dẫn cài đặt lần đầu/ });
    // Reopened mid-setup: lands on the connection step, not on the first one.
    expect(within(dialog).getByRole("heading", { name: "Kết nối để kiểm tra trên bài thật" })).toBeInTheDocument();
    await within(dialog).findByText("Chrome: Đã kết nối");
    expect(within(dialog).getByText(/Quét tự động: Đang tắt/)).toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Tiếp theo: Quét tự động");

    const chromeCalls = chrome.mock.calls.length;
    const probeCalls = probe.mock.calls.length;
    healthGet.mockResolvedValue({ ...off, automatic_scanning: true });
    await user.click(within(dialog).getByRole("button", { name: "Kiểm tra Quét tự động" }));
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Các kết nối bắt buộc đã sẵn sàng"));
    // Only that connection was re-checked.
    expect(chrome.mock.calls.length).toBe(chromeCalls);
    expect(probe.mock.calls.length).toBe(probeCalls);
    expect(within(dialog).getByText(/Quét tự động: Đã bật/)).toBeInTheDocument();
  });
});
