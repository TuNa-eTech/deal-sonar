import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { api } from "../lib/api";
import { getMockCommandCalls } from "../lib/mockBackend";

describe("Radar comparison", () => {
  it("compares two definitions on the same group and shows per-post reasons without side effects", async () => {
    const user = userEvent.setup();
    const original = (await api.radarList()).find((r) => r.status === "active" && r.source_ids.length)!;
    const proposal = await api.radarVariantPrepare(original.id);
    // The mock treats this wording as "matches nothing", so every post the original matches disappears.
    const variant = await api.radarCreateVariant({
      source_radar_id: original.id,
      input: { ...proposal.input, description: `${proposal.input.description} sao hoa` },
    });
    const leadsBefore = (await api.leadList({} as never)).items.length;

    render(<App />);
    await screen.findByRole("heading", { name: "Cơ hội" });
    await user.click(screen.getByRole("button", { name: /^Radar/i }));
    await screen.findByRole("heading", { name: "Quản lý Radar" });
    const row = (await screen.findAllByRole("row")).find((r) =>
      within(r).queryByRole("button", { name: original.name })
    )!;
    await user.click(within(row).getByRole("button", { name: "So sánh" }));

    const dialog = await screen.findByRole("dialog", { name: "So sánh biến thể Radar" });
    expect(within(dialog).getByText(/không tạo cơ hội thật, không gửi thông báo/)).toBeInTheDocument();
    expect(((await within(dialog).findByLabelText("Radar B")) as HTMLSelectElement).value).toBe(variant.radar.id);
    expect(((await within(dialog).findByLabelText("Radar A")) as HTMLSelectElement).value).toBe(original.id);

    const run = within(dialog).getByRole("button", { name: "So sánh" });
    await waitFor(() => expect(run).not.toBeDisabled());
    await user.click(run);

    const results = await within(dialog).findByRole("region", { name: "Kết quả so sánh" });
    expect(within(results).getByText(/Hết khớp 2/)).toBeInTheDocument();
    expect(within(results).getByText(/5 bài/)).toBeInTheDocument();
    expect(within(results).getByText(/Bài hết khớp ở B \(2\)/)).toBeInTheDocument();
    expect(within(results).getAllByText(/Hết khớp ở B: bị loại/).length).toBe(2);
    expect(within(results).getByText(/Hai định nghĩa khác nhau ở: mô tả/)).toBeInTheDocument();

    // The comparison recorded versions and posts, and nothing real was created.
    const [summary] = await api.radarCompareList();
    const record = await api.radarCompareGet(summary!.id);
    expect(record.left).toMatchObject({ radar_id: original.id, version: original.current_version });
    expect(record.right).toMatchObject({ radar_id: variant.radar.id, version: 1 });
    expect(record.post_ids).toHaveLength(5);
    const cmds = getMockCommandCalls().map((c) => c.cmd);
    expect(cmds).toContain("radar_compare_run");
    expect(cmds).not.toContain("radar_set_status");
    expect(cmds).not.toContain("lead_feedback");
    expect((await api.leadList({} as never)).items.length).toBe(leadsBefore);
    expect((await api.radarGet(variant.radar.id)).radar.status).toBe("draft");
  });
});
