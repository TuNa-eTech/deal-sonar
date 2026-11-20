import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadarWizard } from "../components/RadarWizard";
import { api } from "../lib/api";
import type { PreviewRunState } from "../types/ipc";

afterEach(() => vi.restoreAllMocks());

async function renderPreview(status: "evaluating" | "error" = "evaluating") {
  const [radars, templates, sources, license] = await Promise.all([
    api.radarList(), api.templateList(), api.sourceList(), api.licenseGet(),
  ]);
  const radar = await api.radarGet(radars[0]!.id);
  const initial: PreviewRunState = {
    preview_id: "real-preview", radar_id: radar.radar.id, radar_version: 1,
    status, total_posts: 7, evaluated_posts: 0, failed_posts: status === "error" ? 7 : 0,
    items: [], warnings: [], error: status === "error" ? "AI đã hết thời gian chờ" : null,
  };
  vi.spyOn(api, "radarPreviewStart").mockResolvedValue(initial);
  const get = vi.spyOn(api, "radarPreviewGet").mockResolvedValue(initial);
  await act(async()=>{render(<RadarWizard templates={templates} sources={sources} license={license}
    editRadar={radar} initialStep={4} onClose={vi.fn()} onSaved={vi.fn()} />);});
  return { initial, get };
}

describe("Radar preview lifecycle", () => {
  it("reviews a completed draft preview and activates only after the user's click", async () => {
    const [templates, sources, license, health] = await Promise.all([
      api.templateList(), api.sourceList(), api.licenseGet(), api.healthGet(),
    ]);
    const template = templates[0]!;
    const sourceIds = [sources[0]!.id];
    const radar = await api.radarCreateDraft({
      name: "Radar nháp từ agent", description: "Tìm người cần thuê căn hộ",
      template_id: null, user_profession: null,
      fields: template.fields, match_policy: template.match_policy, source_ids: sourceIds,
    });
    const preview: PreviewRunState = {
      preview_id: "agent-preview", radar_id: radar.radar.id,
      radar_version: radar.current_version_data.version, source_ids: sourceIds,
      status: "done", total_posts: 1, evaluated_posts: 1, items: [], warnings: [], error: null,
    };
    vi.spyOn(api, "healthGet").mockResolvedValue({
      ...health, automatic_scanning: true, extension_connected: true,
      facebook_session: "ok", crawl_paused: false,
    });
    vi.spyOn(api, "radarPreviewGet").mockResolvedValue(preview);
    const start = vi.spyOn(api, "radarPreviewStart");
    const activate = vi.spyOn(api, "radarSetStatus").mockResolvedValue({ ...radar.radar, status: "active" });
    const onSaved = vi.fn();
    render(<RadarWizard templates={templates} sources={sources} license={license}
      editRadar={radar} initialStep={4} onClose={vi.fn()} onSaved={onSaved} />);
    const button = screen.getByRole("button", { name: "Bật radar" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(start).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    await userEvent.click(button);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(radar.radar.id));
    expect(activate).toHaveBeenCalledWith(radar.radar.id, "active", "agent-preview");
  });

  it("shows backend errors instead of keeping the 0/7 processing banner", async () => {
    await renderPreview("error");
    expect(await screen.findByRole("alert")).toHaveTextContent("AI đã hết thời gian chờ");
    expect(screen.queryByText(/Đang chấm AI theo lô/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chạy lại xem thử/ })).toBeEnabled();
  });

  it("recovers a missed terminal event by polling and prevents overlapping edits", async () => {
    const { initial, get } = await renderPreview();
    expect(await screen.findByText(/Đang chấm AI theo lô: đã chấm 0\/7/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chạy lại xem thử/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sửa tiêu chí và nguồn" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Áp dụng & Bật radar" })).toBeDisabled();
    get.mockResolvedValue({ ...initial, status: "error", failed_posts: 7, error: "Kết nối AI bị gián đoạn" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Kết nối AI bị gián đoạn"), { timeout: 2500 });
    expect(get).toHaveBeenCalledWith(initial.radar_id, initial.preview_id);
    expect(screen.queryByText(/Đang chấm AI theo lô/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chạy lại xem thử/ })).toBeEnabled();
  });

  it("stops the backend preview and restores actions", async () => {
    const { initial } = await renderPreview();
    const cancel = vi.spyOn(api, "radarPreviewCancel").mockResolvedValue({ ...initial, status: "error", error: "Đã dừng xem thử." });
    await userEvent.click(await screen.findByRole("button", { name: "Dừng xem thử" }));
    expect(cancel).toHaveBeenCalledWith(initial.radar_id, initial.preview_id);
    expect(await screen.findByRole("alert")).toHaveTextContent("Đã dừng xem thử.");
    expect(screen.getByRole("button", { name: /Chạy lại xem thử/ })).toBeEnabled();
  });
});
