import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { getMockCommandCalls } from "../lib/mockBackend";
import { api } from "../lib/api";

const selectedRow = () => document.querySelector<HTMLElement>(".lead-row-item.selected");

describe("Triage queue", () => {
  it("moves with J/K, skips with B and opens the next lead", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Cơ hội" });
    await waitFor(() => expect(selectedRow()).not.toBeNull());
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".lead-row-item"));
    expect(rows().length).toBeGreaterThan(1);

    const first = selectedRow()!.textContent;
    await user.keyboard("j");
    await waitFor(() => expect(selectedRow()!.textContent).not.toBe(first));
    await user.keyboard("k");
    await waitFor(() => expect(selectedRow()!.textContent).toBe(first));

    // The detail panel must have loaded before its shortcuts are live.
    await screen.findByRole("toolbar", { name: "Quyết định cho tin này" });
    await user.keyboard("b");
    await waitFor(() => {
      const call = getMockCommandCalls().find((c) => c.cmd === "lead_set_status" && c.args.status === "ignored");
      expect(call).toBeDefined();
    });
    await waitFor(() => expect(selectedRow()?.textContent).not.toBe(first));
    expect(screen.getByRole("button", { name: "Hoàn tác" })).toBeInTheDocument();
  });

  it("ignores shortcuts while typing in a field", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Cơ hội" });
    await screen.findByRole("toolbar", { name: "Quyết định cho tin này" });
    const before = getMockCommandCalls().filter((c) => c.cmd === "lead_set_status").length;
    await user.type(screen.getByLabelText("Tìm cơ hội"), "b");
    expect(getMockCommandCalls().filter((c) => c.cmd === "lead_set_status").length).toBe(before);
  });

  it("opens the wrong-reason menu with S and picks a reason by number", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("toolbar", { name: "Quyết định cho tin này" });
    await user.keyboard("s");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(5);
    await user.keyboard("1");
    await waitFor(() => {
      const call = getMockCommandCalls().find(
        (c) => c.cmd === "lead_feedback" && (c.args.input as { label?: string }).label === "irrelevant"
      );
      expect(call).toBeDefined();
    });
  });

  it("switches queues and shows the always-on heartbeat", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Cơ hội" });
    expect(screen.getByRole("button", { name: /^Trạng thái:/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Hẹn hôm nay/ }));
    // The page query (limit 50) for the due queue filters by follow-up time, not by status.
    await waitFor(() => {
      const pageQueries = getMockCommandCalls()
        .filter((c) => c.cmd === "lead_list")
        .map((c) => c.args.query as { follow_up_before?: number; limit?: number; status?: string[] })
        .filter((q) => q.limit === 50);
      const last = pageQueries[pageQueries.length - 1]!;
      expect(last.follow_up_before).toBeGreaterThan(Date.now());
      expect(last.status).toBeUndefined();
    });
  });

  it("moves leads past their radar's lifetime out of Mới into Quá hạn", async () => {
    // Seeded leads were posted about a day ago; a 1-hour lifetime makes them stale.
    for (const r of await api.radarList()) await api.radarUpdate({ id: r.id, notify: { lead_ttl_hours: 1 } });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Cơ hội" });
    const expiredTab = await screen.findByRole("button", { name: /^Tin hết hạn/ });
    expect(await screen.findByText("Không còn tin cần xử lý.")).toBeInTheDocument();
    await user.click(expiredTab);
    await waitFor(() => expect(document.querySelectorAll(".lead-row-item").length).toBeGreaterThan(0));
    expect(document.querySelector(".lead-row-item .age-chip.expired")).not.toBeNull();
  });

  it("hides the Quá hạn queue when nothing has expired", async () => {
    render(<App />);
    await screen.findByRole("toolbar", { name: "Quyết định cho tin này" });
    expect(screen.queryByRole("button", { name: /^Tin hết hạn/ })).toBeNull();
  });

  it("shows the poster's recent activity in the contact card", async () => {
    render(<App />);
    await screen.findByRole("toolbar", { name: "Quyết định cho tin này" });
    const card = await screen.findByRole("region", { name: "Liên hệ" });
    const note = await within(card).findByLabelText("Lịch sử người đăng");
    expect(note.textContent).toMatch(/Lần đầu thấy|bài trong 7 ngày/);
  });

  it("takes the lead lifetime from the chosen trade template", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Cơ hội" });
    await user.click(screen.getAllByRole("button", { name: "+ Tạo radar" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Trình tạo và sửa Radar" });
    await user.click(within(dialog).getByRole("button", { name: /^Chọn mẫu theo ngành/ }));
    const lifetime = () => within(dialog).getByText("Tin còn giá trị").nextElementSibling?.textContent;
    await user.click(within(dialog).getByRole("button", { name: /Tuyển dụng/i }));
    await waitFor(() => expect(lifetime()).toBe("30 ngày"));
    await user.click(within(dialog).getByRole("button", { name: "Đổi mẫu" }));
    await user.click(within(dialog).getByRole("button", { name: /Xe và đồ cũ/i }));
    await waitFor(() => expect(lifetime()).toBe("6 giờ"));
  });
});
