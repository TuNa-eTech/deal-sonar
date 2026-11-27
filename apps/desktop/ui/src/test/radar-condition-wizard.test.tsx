import React, { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadarWizard } from "../components/RadarWizard";
import { api } from "../lib/api";
import type { FilterExpr, PreviewItem, PreviewRunState } from "../types/ipc";

afterEach(() => vi.restoreAllMocks());

const leaf = (field: string, op: "lte" | "gt", value: number) => ({ field, op, value, when_missing: "fail" as const });

async function savedRadarWithCondition(condition: FilterExpr) {
  const radars = await api.radarList();
  const detail = await api.radarGet(radars[0]!.id);
  const mp = detail.current_version_data.match_policy;
  await api.radarUpdate({ id: detail.radar.id, match_policy: { ...mp, condition } });
  return api.radarGet(detail.radar.id);
}

async function renderEdit(radar: Awaited<ReturnType<typeof api.radarGet>>, initialStep: 1 | 4 = 1) {
  const [templates, sources, license] = await Promise.all([api.templateList(), api.sourceList(), api.licenseGet()]);
  await act(async () => {
    render(<RadarWizard templates={templates} sources={sources} license={license}
      editRadar={radar} initialStep={initialStep} onClose={vi.fn()} onSaved={vi.fn()} />);
  });
}

describe("Radar condition editing in the wizard", () => {
  it("reopens a saved condition, lets the user edit it by field label and sends it to preview", async () => {
    const condition: FilterExpr = { any: [leaf("price", "lte", 5_000_000), { not: leaf("price", "gt", 20_000_000) }] };
    const radar = await savedRadarWithCondition(condition);
    expect((radar.pending_version_data ?? radar.current_version_data).match_policy.condition).toEqual(condition);
    const priceLabel = radar.current_version_data.fields.find(f => f.key === "price")!.label;

    const start = vi.spyOn(api, "radarPreviewStart").mockResolvedValue({
      preview_id: "p1", radar_id: radar.radar.id, radar_version: 1, status: "evaluating",
      total_posts: 3, evaluated_posts: 0, items: [], warnings: [], error: null,
    } as PreviewRunState);
    vi.spyOn(api, "radarPreviewGet").mockResolvedValue({
      preview_id: "p1", radar_id: radar.radar.id, radar_version: 1, status: "evaluating",
      total_posts: 3, evaluated_posts: 0, items: [], warnings: [], error: null,
    } as PreviewRunState);
    await renderEdit(radar);

    // Shown with the field's visible name, not a key or JSON.
    const first = "Nhóm điều kiện › 1";
    expect(screen.getByLabelText(`${first}: trường`)).toHaveDisplayValue(priceLabel);
    expect(screen.getByLabelText(`${first}: giá trị`)).toHaveValue("5000000");
    expect(screen.getByLabelText("Nhóm điều kiện › 2, điều kiện loại: giá trị")).toHaveValue("20000000");
    expect(screen.getByTestId("condition-summary")).toHaveTextContent("KHÔNG");

    const user = userEvent.setup();
    const box = screen.getByLabelText(`${first}: giá trị`);
    await user.clear(box);
    await user.type(box, "8 triệu");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Chạy xem thử" }));

    await waitFor(() => expect(start).toHaveBeenCalled());
    const sent = start.mock.calls[0]![0].match_policy!.condition as { any: FilterExpr[] };
    expect(sent.any[0]).toEqual(leaf("price", "lte", 8_000_000));
    expect(sent.any[1]).toEqual({ not: leaf("price", "gt", 20_000_000) });
  });

  it("explains each previewed post and rechecks a post marked as missed after the run is repeated", async () => {
    const radar = await savedRadarWithCondition({ any: [leaf("price", "lte", 5_000_000)] });
    const base = (over: Partial<PreviewItem>): PreviewItem => ({
      evaluation_id: "e1", post_id: "post-missed", verdict: "no_match", score: 0.3, intent: "demand",
      author_role: "end_user", summary: "Cần thuê căn hộ", reason: "Không đạt điều kiện lọc cứng (hard_filters)",
      decided_by: "ai", fields: {}, source_name: "Nhóm A", author_name: "An", permalink: "https://x/1",
      post_text: "Cần thuê căn hộ", post_created_at: null, feedback_label: null, ...over,
    });
    const failing = base({ filter_trace: { kind: "any", passed: false, children: [
      { kind: "filter", passed: false, field: "price", op: "lte", value: 5_000_000, when_missing: "fail", missing: true }] } });
    const run = (items: PreviewItem[], id: string): PreviewRunState => ({
      preview_id: id, radar_id: radar.radar.id, radar_version: 1, status: "done",
      total_posts: items.length, evaluated_posts: items.length, items, warnings: [], error: null,
    });
    const first = run([failing], "run-1");
    vi.spyOn(api, "radarPreviewStart").mockResolvedValueOnce(first).mockResolvedValue(run([
      base({ evaluation_id: "e2", verdict: "match", score: 0.9, reason: "Khớp", filter_trace: { kind: "any", passed: true, children: [
        { kind: "filter", passed: true, field: "price", op: "lte", value: 8_000_000, when_missing: "fail" }] } })], "run-2"));
    vi.spyOn(api, "radarPreviewGet").mockImplementation(async () => first);
    vi.spyOn(api, "leadFeedback").mockResolvedValue(undefined as never);
    await renderEdit(radar, 4);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Bị loại \(1\)/ }));
    const priceLabel = radar.current_version_data.fields.find(f => f.key === "price")!.label;
    expect(await screen.findByText(new RegExp(`Điều kiện lọc: không đạt · thiếu thông tin: ${priceLabel}`))).toBeInTheDocument();
    expect(screen.getByText("Không nhánh nào đạt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Đáng lẽ phải khớp" }));
    expect(await screen.findByText(/Bài bạn đánh dấu «Đáng lẽ phải khớp» \(1\)/)).toBeInTheDocument();
    expect(screen.getByTestId("missed-recheck-item")).toHaveTextContent("Vẫn bị loại");

    await user.click(screen.getByRole("button", { name: /Chạy lại xem thử/ }));
    await waitFor(() => expect(screen.getByTestId("missed-recheck-item")).toHaveTextContent("Giờ đã khớp"));
  });
});
