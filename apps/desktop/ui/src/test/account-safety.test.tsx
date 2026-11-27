import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSafetyLog } from "../components/AccountSafetyLog";
import { api } from "../lib/api";
import type { AccountSafetyReport } from "../types/ipc";

afterEach(() => vi.restoreAllMocks());

describe("Account safety log", () => {
  it("lists each incident with the page loads before it, newest first", async () => {
    const base = await api.accountSafetyReport(30);
    const report: AccountSafetyReport = {
      ...base,
      active_days: [{ date: "2026-12-01", runs: 40, page_loads: 52, blocked_runs: 0 }],
      incidents: [
        { id: "a", kind: "checkpoint", occurred_at: 1_800_000_000_000, detail: "/checkpoint/", page_loads_24h: 212,
          page_loads_1h: 14, scanning_paused: true, resolved_at: 1_800_000_900_000 },
        { id: "b", kind: "logged_out", occurred_at: 1_800_100_000_000, detail: "", page_loads_24h: 180,
          page_loads_1h: 9, scanning_paused: true, resolved_at: null },
      ],
    };
    vi.spyOn(api, "accountSafetyReport").mockResolvedValue(report);
    const health = await api.healthGet();
    render(<AccountSafetyLog health={health} />);

    const region = await screen.findByRole("region", { name: "Nhật ký an toàn tài khoản" });
    expect(within(region).getByText(/2 sự cố/)).toBeInTheDocument();
    expect(within(region).getByText(/Có quét trong 1 ngày/)).toBeInTheDocument();
    const rows = within(region).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Bị đăng xuất bất thường");
    expect(rows[0]).toHaveTextContent("180 lượt tải trong 24 giờ trước");
    expect(rows[0]).toHaveTextContent("chưa ổn định");
    expect(rows[1]).toHaveTextContent("Facebook yêu cầu xác minh");
    expect(rows[1]).toHaveTextContent("212 lượt tải trong 24 giờ trước (14 trong 1 giờ trước)");
    expect(rows[1]).toHaveTextContent("phiên ổn định lại");
  });

  it("says plainly when nothing has happened and copies the report as JSON", async () => {
    const user = userEvent.setup();
    const report = await api.accountSafetyReport(30);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    render(<AccountSafetyLog health={null} />);
    expect(await screen.findByText(/Chưa ghi nhận lần xác minh/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sao chép báo cáo JSON" }));
    expect(JSON.parse(write.mock.calls[0]![0] as string).window_days).toBe(report.window_days);
  });
});
