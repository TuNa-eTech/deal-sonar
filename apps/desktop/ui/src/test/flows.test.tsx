import React, { act } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { api } from "../lib/api";
import {
  getMockCommandCalls,
  resetMockBackend,
  setMockHealth,
} from "../lib/mockBackend";

describe("Radar setup and UX flows", () => {
  it("chooses a source with AI, saves a draft and previews before the user's activation", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Cơ hội" });

    // Open Radar Wizard
    await user.click(screen.getAllByRole("button", { name: "+ Tạo radar" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Trình tạo và sửa Radar" });

    // Step 1: Select "Bài hỏi \"ai biết thợ…\"" template and fill inline placeholders
    await user.click(within(dialog).getByRole("button", { name: /^Chọn mẫu theo ngành/ }));
    const thoTplBtn = within(dialog).getByRole("button", {
      name: /Dịch vụ nhà cửa/i,
    });
    await user.click(thoTplBtn);

    const jobPlaceholder = within(dialog).getByLabelText("Điền loại việc");
    const areaPlaceholder = within(dialog).getByLabelText("Điền khu vực");
    await user.clear(jobPlaceholder);
    await user.type(jobPlaceholder, "sửa điều hoà âm trần");
    await user.clear(areaPlaceholder);
    await user.type(areaPlaceholder, "Quận Cầu Giấy");

    const descTextarea = within(dialog).getByLabelText(
      "Mô tả nhu cầu"
    ) as HTMLTextAreaElement;
    expect(descTextarea.value).toContain("sửa điều hoà âm trần");
    expect(descTextarea.value).toContain("Quận Cầu Giấy");

    expect(within(dialog).getByRole("heading", { name: "AI hiểu nhu cầu của bạn" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", {name:/Tùy chỉnh thông tin/}));
    // Add a custom field and customize its label
    await user.click(within(dialog).getByRole("button", { name: "+ Thêm trường" }));
    const customLabelInput = within(dialog).getByLabelText("Tên trường 5");
    await user.clear(customLabelInput);
    await user.type(customLabelInput, " Hãng máy lạnh");

    await user.click(within(dialog).getByRole("button", { name: "Chạy xem thử" }));

    // Wait for streaming preview batch completion (5/5 posts)
    await waitFor(() => {
      expect(within(dialog).getByText(/\(5 \/ 5 bài\)/)).toBeInTheDocument();
    });

    expect(within(dialog).getByText(/✓ Khớp \(2\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/✕ Không khớp \(3\)/)).toBeInTheDocument();
    const beforeActivation = getMockCommandCalls();
    const request = beforeActivation.find(call => call.cmd === "radar_suggest_fields");
    expect(request?.args.input).toMatchObject({ suggest_sources: true });
    const group = (await api.sourceList()).find(source => source.name.includes("Tìm Thợ Sửa Điện Nước"))!;
    const created = beforeActivation.find(call => call.cmd === "radar_create_draft")!;
    expect(created.args.input).toMatchObject({ source_ids: [group.id] });
    expect(beforeActivation.some(call => call.cmd === "radar_set_status")).toBe(false);
    expect((await api.radarList()).some(radar => radar.status === "draft" && radar.source_ids.includes(group.id))).toBe(true);

    // Give feedback on a preview item
    const correctBtns = within(dialog).getAllByRole("button", { name: /^Đúng$/i });
    await user.click(correctBtns[0]!);

    // Activate radar
    await user.click(within(dialog).getByRole("button", { name: "Bật radar" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Trình tạo và sửa Radar" })).not.toBeInTheDocument();
    });

    const calls = getMockCommandCalls().map((c) => c.cmd);
    expect(calls).toContain("radar_create_draft");
    expect(calls).toContain("radar_preview_start");
    expect(calls).toContain("lead_feedback");
    expect(calls).toContain("radar_set_status");
    const activation = getMockCommandCalls().find(c => c.cmd === "radar_set_status");
    expect(activation?.args.preview_id).toEqual(expect.any(String));
    const presetRadar = (await api.radarList()).find(r => r.id === activation?.args.id);
    expect(presetRadar?.notify).toMatchObject({ inherit_channels: false, channel_ids: [] });
  });

  it("stays on setup without creating a draft when AI finds no suitable group", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Cơ hội" });
    await user.click(screen.getAllByRole("button", { name: "+ Tạo radar" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Trình tạo và sửa Radar" });
    await user.type(within(dialog).getByLabelText("Mô tả nhu cầu"), "Tìm người cần mua đàn piano cho phòng thu ở Huế");
    await user.click(within(dialog).getByRole("button", { name: "Chạy xem thử" }));
    expect(await within(dialog).findByText(/AI chưa tìm thấy nhóm phù hợp/)).toBeInTheDocument();
    expect(getMockCommandCalls().map(call => call.cmd)).not.toContain("radar_create_draft");
    expect(within(dialog).queryByRole("button", { name: "Bật radar" })).not.toBeInTheDocument();
  });

  it("renders dynamic Bảng tin columns, builds typed LeadFilterQuery, exports CSV, and handles Lead feedback actions", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Cơ hội" });

    // 1. Test Lead feedback ("Sai ▾" -> "Người cùng nghề…" -> "Chặn luôn tác giả này") & inline field edit in Inbox
    const inlineEditBtns = await screen.findAllByTitle("Bấm để sửa tay trường này");
    await user.click(inlineEditBtns[0]!);
    const editInput = screen.getByLabelText(/Giá trị mới cho/i);
    await user.selectOptions(editInput, "thuê");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    await waitFor(() => {
      expect(screen.getByText(/Bạn đã sửa/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^Sai/i }));
    await user.click(screen.getByRole("menuitem", { name: /Người cùng nghề/i }));
    expect(screen.getByText(/Đánh dấu «Người cùng nghề»/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chặn luôn tác giả này" }));

    const fbCall = getMockCommandCalls().find(
      (c) =>
        c.cmd === "lead_feedback" &&
        (c.args.input as { label?: string; block_author?: boolean })?.label === "peer"
    );
    expect(fbCall).toBeDefined();
    expect((fbCall!.args.input as { block_author: boolean }).block_author).toBe(true);

    // 2. Navigate to Bảng tin (Dynamic CRM Table)
    await user.click(screen.getByRole("tab", { name: "Bảng tin" }));
    await screen.findByRole("heading", { name: /Bảng tin/i });

    await user.selectOptions(screen.getByLabelText("Chọn Radar cho Bảng tin"), screen.getByLabelText("Chọn Radar cho Bảng tin").querySelectorAll("option")[1]!.value);
    await waitFor(()=>expect(screen.getAllByRole("columnheader").some(h=>h.textContent?.includes("Loại giao dịch"))).toBe(true));
    const table = await screen.findByTestId("dynamic-lead-table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent?.trim() ?? "");

    // Verify dynamic columns from "Khách thuê căn hộ Cầu Giấy" (`bds.khach-thue`)
    expect(headers.some((h) => h.includes("Loại giao dịch"))).toBe(true);
    expect(headers.some((h) => h.includes("Khu vực"))).toBe(true);
    expect(headers.some((h) => h.includes("Giá / Ngân sách"))).toBe(true);
    expect(headers.some((h) => h.includes("Số điện thoại"))).toBe(true);

    // Add dynamic filter: Giá / Ngân sách <= 11000000
    await user.click(screen.getByRole("button", { name: /\+ Thêm điều kiện lọc theo trường/i }));
    await user.selectOptions(screen.getByLabelText("Trường lọc 1"), "price");
    await user.selectOptions(screen.getByLabelText("Toán tử lọc 1"), "lte");
    await user.type(screen.getByLabelText("Giá trị lọc 1"), "11000000");

    await waitFor(() => {
      const leadListCalls = getMockCommandCalls().filter((c) => c.cmd === "lead_list");
      const latest = leadListCalls[leadListCalls.length - 1];
      const q = latest?.args.query as {
        filters?: Array<{ field: string; op: string; value: unknown }>;
      };
      expect(q?.filters).toEqual([{ field: "price", op: "lte", value: 11000000 }]);
    });

    // Export CSV
    await user.click(screen.getByRole("button", { name: /Xuất CSV/i }));
    await waitFor(() => {
      expect(screen.getByText(/Đã xuất .* sang định dạng CSV/i)).toBeInTheDocument();
    });
  });

  it("enforces privacy consent on first run and disables 'Tiếp tục' until Facebook session recovers", async () => {
    resetMockBackend({ onboarding: true });
    const user = userEvent.setup();
    render(<App />);

    const consentDialog = await screen.findByRole("dialog", {
      name: /Đồng ý quyền riêng tư và an toàn/i,
    });
    const acceptBtn = within(consentDialog).getByRole("button", {
      name: /Đồng ý và bắt đầu cài đặt/i,
    });
    expect(acceptBtn).toBeDisabled();

    await user.click(within(consentDialog).getByRole("checkbox"));
    expect(acceptBtn).not.toBeDisabled();
    await user.click(acceptBtn);

    const onboardingDialog=await screen.findByRole("dialog",{name:/Hướng dẫn cài đặt lần đầu/i});
    await user.type(within(onboardingDialog).getByLabelText("Mục tiêu tìm cơ hội"),"Khách cần thuê căn hộ");
    await user.click(within(onboardingDialog).getByRole("button",{name:"Tiếp tục"}));
    await within(onboardingDialog).findByText("Chrome: Đã kết nối");
    await user.click(within(onboardingDialog).getByRole("button",{name:"Tiếp tục"}));
    await user.click(within(onboardingDialog).getByRole("button",{name:"Vào không gian làm việc"}));

    // Trigger Facebook checkpoint health state -> "Tiếp tục" must be disabled!
    act(() => {
      setMockHealth({
        facebook_session: "checkpoint",
        crawl_paused: true,
        crawl_pause_reason: "checkpoint_awaiting_resume",
      });
    });

    const resumeBtn = await screen.findByRole("button", { name: "Tiếp tục" });
    expect(resumeBtn).toBeDisabled();

    // Once Facebook session returns to "ok", "Tiếp tục" becomes enabled!
    act(() => {
      setMockHealth({
        facebook_session: "ok",
        crawl_paused: true,
        crawl_pause_reason: "checkpoint_awaiting_resume",
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tiếp tục" })).not.toBeDisabled();
    });
  });
});
