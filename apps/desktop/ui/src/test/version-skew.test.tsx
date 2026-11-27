import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GlobalHealthBanner } from "../components/GlobalHealthBanner";
import { operationState } from "../components/OperationStatus";
import { api } from "../lib/api";
import type { ExtensionCompat, HealthStatus } from "../types/ipc";

const mismatch: ExtensionCompat = {
  state: "protocol_mismatch", extension_version: null, desktop_version: "0.3.0", min_extension_version: "0.1.0",
  message: "Tiện ích Chrome và ứng dụng DealSonar không khớp phiên bản giao thức (unsupported protocol version 3).",
  action: "Cập nhật cả hai lên cùng bản phát hành, rồi bấm Kiểm tra lại. Radar, tin và cài đặt trên máy được giữ nguyên.",
};

async function health(over: Partial<HealthStatus>): Promise<HealthStatus> {
  return { ...(await api.healthGet()), ...over };
}

describe("Chrome and Desktop updated out of step", () => {
  it("shows which side to update, that data is kept, and a retry instead of the generic disconnect banner", async () => {
    const onRetry = vi.fn();
    render(<GlobalHealthBanner health={await health({ extension_connected: false, extension_compat: mismatch })}
      onRetryConnect={onRetry} onRetryAi={vi.fn()} onResumeCrawl={vi.fn()} onOpenRadars={vi.fn()} />);
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent ?? "");
    expect(alerts.some((t) => t.includes("Cần cập nhật Chrome hoặc ứng dụng") && t.includes("được giữ nguyên"))).toBe(true);
    expect(alerts.some((t) => t.includes("Mất kết nối Chrome Extension"))).toBe(false);
    expect(screen.getByRole("button", { name: "Kiểm tra lại kết nối" })).toBeInTheDocument();
  });

  it("an outdated but connected extension is a warning, not a failure", async () => {
    const outdated: ExtensionCompat = { ...mismatch, state: "extension_outdated", extension_version: "0.0.9" };
    const state = operationState(await health({ extension_connected: true, extension_compat: outdated }));
    expect(state.label).toBe("Cần cập nhật Chrome hoặc ứng dụng");
    expect(state.tone).toBe("warning");
    expect(operationState(await health({ extension_connected: false, extension_compat: mismatch })).tone).toBe("danger");
  });

  it("without a compat problem the usual status is unchanged", async () => {
    expect(operationState(await health({ extension_connected: false, extension_compat: null })).label).toBe("Chờ Chrome");
  });
});
