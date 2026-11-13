import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { getMockCommandCalls } from "../lib/mockBackend";

describe("All 7 Main Screens Coverage (Radar, Nguồn, Danh bạ, Sức khoẻ, Cài đặt, Rejected Modal)", () => {
  it("inspects 7d Funnel & edits Ruleset keywords (`origin: user`), searches raw posts, manages Contacts/Blocklist, creates Diagnostic Bundle, and double-confirms Delete All", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Cơ hội" });

    // 1. Rejected posts modal & "Đánh dấu bỏ sót" (`missed`)
    await user.click(screen.getByRole("button", { name: /Xem các bài bị loại gần nhất/i }));
    const rejDialog = await screen.findByRole("dialog", { name: /Các bài bị loại gần nhất/i });
    const missedBtns = within(rejDialog).getAllByRole("button", { name: /Đánh dấu bỏ sót/i });
    await user.click(missedBtns[0]!);
    await waitFor(() => {
      expect(within(rejDialog).getByText(/Đã đánh dấu bỏ sót/i)).toBeInTheDocument();
    });
    await user.click(within(rejDialog).getByRole("button", { name: /Đóng/i }));

    // 2. Radar Screen: 7-day Funnel + Ruleset Inspector & user keyword edit
    await user.click(screen.getByRole("button", { name: /^Radar/i }));
    await screen.findByRole("heading", { name: "Quản lý Radar" });
    expect(
      await screen.findByText(/Bộ luật đang tự xử lý 82% số bài, AI xử lý 18%/i)
    ).toBeInTheDocument();

    const rejectKwInput = screen.getByLabelText(/Từ khoá loại ngay/i);
    await user.type(rejectKwInput, ", chinh chu gia ao");
    await user.click(screen.getByRole("button", { name: /Lưu chỉnh sửa từ khoá/i }));
    await waitFor(() => {
      expect(screen.getByText(/origin: "user"/i)).toBeInTheDocument();
    });

    // 3. Nguồn Screen: Crawl Now & Raw Post FTS Search
    await user.click(screen.getByRole("button", { name: /^Nguồn/i }));
    await screen.findByRole("heading", { name: "Nguồn Group Facebook" });
    await user.click(screen.getAllByRole("button", { name: "Quét ngay" })[0]!);
    expect(await screen.findByText(/Đã gửi lệnh quét ngay/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Tìm bài viết thô trong kho/i }));
    const ftsDialog = await screen.findByRole("dialog", { name: /Tìm kiếm bài thô trong kho/i });
    expect((await within(ftsDialog).findAllByText(/Nguyễn Minh Tuấn/i)).length).toBeGreaterThan(0);
    await user.click(within(ftsDialog).getByRole("button", { name: /Đóng/i }));

    // 4. Danh bạ & Blocklist Screen
    await user.click(screen.getByRole("button", { name: "Liên hệ" }));
    await screen.findByRole("heading", { name: /Danh bạ & Danh sách chặn/i });
    expect(await screen.findByText("0912 345 678")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Danh sách chặn/i }));
    expect(await screen.findByText(/Kho Tổng Chung Cư Mini HN/i)).toBeInTheDocument();

    // 5. Sức khoẻ Screen: 4 lamps + Diagnostic Bundle
    await user.click(screen.getByRole("button", { name: /Kết nối/i }));
    await screen.findByRole("heading", { name: /Kết nối & Chẩn đoán/i });
    expect(screen.getByText("1. Chrome Extension")).toBeInTheDocument();
    expect(screen.getByText("2. Phiên Facebook")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tạo gói chẩn đoán/i }));
    expect(await screen.findByText(/Đã tạo gói chẩn đoán/i)).toBeInTheDocument();

    // 6. Cài đặt Screen: Auto-scanned model dropdowns & Double-confirm Delete All Data
    await user.click(screen.getByRole("button", { name: "Cài đặt" }));
    await screen.findByRole("heading", { name: "Cài đặt hệ thống" });

    const fastModelSelect = await screen.findByLabelText("Chọn mô hình tầng Fast");
    const smartModelSelect = await screen.findByLabelText("Chọn mô hình tầng Smart");
    await user.selectOptions(fastModelSelect, "haiku");
    await user.selectOptions(smartModelSelect, "sonnet");
    await user.click(screen.getByRole("button", { name: "Lưu cấu hình AI" }));

    await user.click(screen.getByRole("button", { name: "Dữ liệu" }));
    await user.click(screen.getByRole("button", { name: /Xoá toàn bộ dữ liệu/i }));

    const delDialog = await screen.findByRole("dialog", {
      name: /Xác nhận xoá toàn bộ dữ liệu/i,
    });
    await user.click(
      within(delDialog).getByRole("button", { name: /Tôi hiểu, tiếp tục bước xác nhận cuối/i })
    );

    const finalBtn = within(delDialog).getByRole("button", {
      name: /Xoá vĩnh viễn toàn bộ dữ liệu/i,
    });
    expect(finalBtn).toBeDisabled();

    await user.type(within(delDialog).getByLabelText(/Nhập cụm từ xác nhận xoá/i), "XOA TOAN BO");
    expect(finalBtn).not.toBeDisabled();
    await user.click(finalBtn);

    const calls = getMockCommandCalls().map((c) => c.cmd);
    expect(calls).toContain("ruleset_save_user");
    expect(calls).toContain("source_crawl_now");
    expect(calls).toContain("post_search");
    expect(calls).toContain("diagnostic_bundle_create");
    expect(calls).toContain("data_delete_all");
  });
});
