import React, { act } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadarWizard } from "../components/RadarWizard";
import { api } from "../lib/api";

afterEach(() => vi.restoreAllMocks());

async function openBlankWizard(initialGoal = "") {
  const [templates, sources, license] = await Promise.all([api.templateList(), api.sourceList(), api.licenseGet()]);
  await act(async () => {
    render(<RadarWizard templates={templates} sources={sources} license={license}
      initialGoal={initialGoal} onClose={vi.fn()} onSaved={vi.fn()} />);
  });
  return { templates, sources, license };
}

describe("Radar goal interpretation", () => {
  it("keeps an ambiguous brief neutral, asks for the side and lets the user fix assumptions", async () => {
    const user = userEvent.setup();
    await openBlankWizard();
    const dialog = screen.getByRole("dialog", { name: "Trình tạo và sửa Radar" });
    await user.type(within(dialog).getByLabelText("Mô tả nhu cầu"), "Tìm xe tải hoặc tìm hàng chở khu vực Cầu Giấy");
    await user.click(within(dialog).getByRole("button", { name: "Cập nhật tiêu chí" }));

    const choice = await within(dialog).findByRole("group", { name: "Chọn phía giao dịch" });
    expect(within(dialog).getByLabelText("Loại bài")).toHaveValue("any");
    expect(within(dialog).getByRole("checkbox", { name: /Loại bài chào bán của người cùng nghề/ })).not.toBeChecked();
    expect(within(dialog).getByText("Không loại ai")).toBeInTheDocument();
    const assumption = within(dialog).getByLabelText("Giả định 1") as HTMLInputElement;
    expect(assumption.value).toMatch(/^Chưa rõ bạn muốn tìm bài của người cần/);

    await user.click(within(choice).getByRole("button", { name: "Người đang cần mua / thuê / tìm" }));
    expect(within(dialog).getByLabelText("Loại bài")).toHaveValue("demand");
    expect(within(dialog).queryByRole("group", { name: "Chọn phía giao dịch" })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Giả định 1")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "+ Thêm giả định" }));
    await user.type(within(dialog).getByLabelText("Giả định 1"), "Chỉ tính Cầu Giấy");
    expect(within(dialog).getByLabelText("Giả định 1")).toHaveValue("Chỉ tính Cầu Giấy");
  });

  it("states a clear brief's side, excluded audience and assumption without asking", async () => {
    const user = userEvent.setup();
    await openBlankWizard();
    const dialog = screen.getByRole("dialog", { name: "Trình tạo và sửa Radar" });
    await user.type(within(dialog).getByLabelText("Mô tả nhu cầu"), "Tìm người cần thuê căn hộ ở Cầu Giấy");
    await user.click(within(dialog).getByRole("button", { name: "Cập nhật tiêu chí" }));

    await waitFor(() => expect(within(dialog).getByLabelText("Loại bài")).toHaveValue("demand"));
    expect(within(dialog).queryByRole("group", { name: "Chọn phía giao dịch" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("Người cùng nghề đăng bài chào khách")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Giả định 1")).toHaveValue(
      "Loại bài của người cùng nghề vì mô tả không nói bạn muốn nhận bài từ họ.");
  });

  it("reopens a draft with manual edits intact and does not re-run the AI over them", async () => {
    const user = userEvent.setup();
    const [templates, sources, license] = await Promise.all([api.templateList(), api.sourceList(), api.licenseGet()]);
    const template = templates[0]!;
    const draft = await api.radarCreateDraft({
      name: "Nháp đã chỉnh tay", description: "Tìm căn hộ cho thuê chính chủ", template_id: null,
      user_profession: null, fields: template.fields, source_ids: [sources[0]!.id],
      match_policy: {
        want_intent: "supply", exclude_roles: [], hard_filters: [],
        assumptions: ["Chỉ lấy bài có giá rõ ràng"],
      },
    });
    const suggest = vi.spyOn(api, "radarSuggestFields");
    vi.spyOn(api, "radarPreviewStart").mockResolvedValue({
      preview_id: "p1", radar_id: draft.radar.id, radar_version: 1, status: "evaluating",
      total_posts: 3, evaluated_posts: 0, items: [], warnings: [], error: null,
    });
    await act(async () => {
      render(<RadarWizard templates={templates} sources={sources} license={license}
        editRadar={draft} onClose={vi.fn()} onSaved={vi.fn()} />);
    });
    const dialog = screen.getByRole("dialog", { name: "Trình tạo và sửa Radar" });
    expect(within(dialog).getByLabelText("Loại bài")).toHaveValue("supply");
    expect(within(dialog).getByRole("checkbox", { name: /Loại bài chào bán của người cùng nghề/ })).not.toBeChecked();
    expect(within(dialog).getByLabelText("Giả định 1")).toHaveValue("Chỉ lấy bài có giá rõ ràng");

    await user.click(within(dialog).getByRole("button", { name: "Chạy xem thử" }));
    await waitFor(() => expect(api.radarPreviewStart).toHaveBeenCalled());
    expect(suggest).not.toHaveBeenCalled();
    const reopened = await api.radarGet(draft.radar.id);
    expect(reopened.current_version_data.match_policy).toMatchObject({
      want_intent: "supply", exclude_roles: [], assumptions: ["Chỉ lấy bài có giá rõ ràng"],
    });
  });

  it("only lets the user pick connected groups", async () => {
    const user = userEvent.setup();
    const { sources } = await openBlankWizard();
    const broken = { ...sources[0]!, state: "error" as const };
    vi.spyOn(api, "sourceList").mockResolvedValue([broken, ...sources.slice(1)]);
    const dialog = screen.getByRole("dialog", { name: "Trình tạo và sửa Radar" });
    await user.click(within(dialog).getByText("Xem nguồn"));
    await user.click(within(dialog).getByRole("button", { name: "Làm mới danh sách" }));
    const checkbox = await within(dialog).findByRole("checkbox", { name: `Chọn nguồn ${broken.name}` });
    expect(checkbox).toBeDisabled();
    expect(within(dialog).getAllByText(/Chưa kết nối ổn định/).length).toBeGreaterThan(0);
  });
});

describe("Radar goal interpretation together with condition groups", () => {
  it("keeps the interpretation and the condition group through a preview", async () => {
    const user = userEvent.setup();
    const [templates, sources, license] = await Promise.all([api.templateList(), api.sourceList(), api.licenseGet()]);
    const template = templates[0]!;
    const price = template.fields.find(field => field.type === "money") ?? template.fields[0]!;
    const condition = { any: [{ field: price.key, op: "lte" as const, value: 8_000_000, when_missing: "fail" as const }] };
    const draft = await api.radarCreateDraft({
      name: "Nháp có nhóm điều kiện", description: "Tìm người cần thuê căn hộ", template_id: null,
      user_profession: null, fields: template.fields, source_ids: [sources[0]!.id],
      match_policy: {
        want_intent: "demand", exclude_roles: [], hard_filters: [], condition,
        assumptions: ["Chỉ tính dưới 8 triệu"],
      },
    });
    const start = vi.spyOn(api, "radarPreviewStart").mockResolvedValue({
      preview_id: "p2", radar_id: draft.radar.id, radar_version: 1, status: "evaluating",
      total_posts: 3, evaluated_posts: 0, items: [], warnings: [], error: null,
    });
    await act(async () => {
      render(<RadarWizard templates={templates} sources={sources} license={license}
        editRadar={draft} onClose={vi.fn()} onSaved={vi.fn()} />);
    });
    const dialog = screen.getByRole("dialog", { name: "Trình tạo và sửa Radar" });
    expect(within(dialog).getByLabelText("Giả định 1")).toHaveValue("Chỉ tính dưới 8 triệu");
    expect(within(dialog).getByTestId("condition-summary")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Chạy xem thử" }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls[0]![0].match_policy).toMatchObject({
      want_intent: "demand", condition, assumptions: ["Chỉ tính dưới 8 triệu"],
    });
    const saved = (await api.radarGet(draft.radar.id)).current_version_data.match_policy;
    expect(saved.condition).toEqual(condition);
    expect(saved.assumptions).toEqual(["Chỉ tính dưới 8 triệu"]);
  });

  it("drops a condition group that referred to the old fields when the goal is read again", async () => {
    const user = userEvent.setup();
    const [templates, sources, license] = await Promise.all([api.templateList(), api.sourceList(), api.licenseGet()]);
    const template = templates[0]!;
    const draft = await api.radarCreateDraft({
      name: "Nháp", description: "Tìm người cần thuê căn hộ ở Cầu Giấy", template_id: null,
      user_profession: null, fields: template.fields, source_ids: [sources[0]!.id],
      match_policy: {
        want_intent: "demand", exclude_roles: [], hard_filters: [],
        condition: { any: [{ field: template.fields[0]!.key, op: "eq", value: "x", when_missing: "fail" }] },
      },
    });
    await act(async () => {
      render(<RadarWizard templates={templates} sources={sources} license={license}
        editRadar={draft} onClose={vi.fn()} onSaved={vi.fn()} />);
    });
    const dialog = screen.getByRole("dialog", { name: "Trình tạo và sửa Radar" });
    expect(within(dialog).getByTestId("condition-summary")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cập nhật tiêu chí" }));
    await waitFor(() => expect(within(dialog).queryByTestId("condition-summary")).not.toBeInTheDocument());
  });
});
