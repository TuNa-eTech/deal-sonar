import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { api } from "../lib/api";
import { getMockCommandCalls } from "../lib/mockBackend";

async function openRadars(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await screen.findByRole("heading", { name: "Cơ hội" });
  await user.click(screen.getByRole("button", { name: /^Radar/i }));
  await screen.findByRole("heading", { name: "Quản lý Radar" });
}

describe("Radar variants", () => {
  it("reviews and edits the copy, then saves an independent draft that leaves the original alone", async () => {
    const user = userEvent.setup();
    await openRadars(user);

    const original = (await api.radarList()).find((r) => r.status === "active")!;
    const originalBefore = await api.radarGet(original.id);
    const radarCountBefore = (await api.radarList()).length;

    const row = (await screen.findAllByRole("row")).find((r) =>
      within(r).queryByRole("button", { name: original.name })
    )!;
    await user.click(within(row).getByRole("button", { name: "Tạo biến thể" }));

    const dialog = await screen.findByRole("dialog", { name: "Tạo biến thể Radar" });
    // Nothing is saved while the copy is only being reviewed.
    expect(getMockCommandCalls().some((c) => c.cmd === "radar_create_variant")).toBe(false);
    expect((await api.radarList()).length).toBe(radarCountBefore);

    const nameInput = (await within(dialog).findByLabelText("Tên biến thể")) as HTMLInputElement;
    expect(nameInput.value).toBe(`${original.name} (biến thể)`);
    expect((within(dialog).getByLabelText("Mô tả nhu cầu") as HTMLTextAreaElement).value).toBe(
      originalBefore.current_version_data.description
    );
    expect(within(dialog).getByText(/Sao chép nguyên từ Radar gốc/)).toBeInTheDocument();

    await user.clear(nameInput);
    await user.type(nameInput, "Khách thuê Thủ Đức");
    await user.selectOptions(within(dialog).getByLabelText("Chế độ thông báo"), "digest");
    const otherSource = (await api.sourceList()).find((s) => !original.source_ids.includes(s.id))!;
    await user.click(within(dialog).getByLabelText(`Nguồn ${otherSource.name}`));
    await user.click(within(dialog).getByRole("button", { name: "Lưu biến thể (bản nháp)" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Tạo biến thể Radar" })).not.toBeInTheDocument()
    );
    expect(await screen.findByText(/Đã tạo biến thể “Khách thuê Thủ Đức” ở trạng thái bản nháp/)).toBeInTheDocument();

    const saved = getMockCommandCalls().find((c) => c.cmd === "radar_create_variant")!;
    expect(saved.args.input).toMatchObject({
      source_radar_id: original.id,
      input: { name: "Khách thuê Thủ Đức", notify: { mode: "digest" } },
    });

    const radars = await api.radarList();
    const variant = radars.find((r) => r.name === "Khách thuê Thủ Đức")!;
    expect(variant.id).not.toBe(original.id);
    expect(variant.status).toBe("draft");
    expect(variant.variant_of).toBe(original.id);
    expect(variant.current_version).toBe(1);
    expect(variant.source_ids).toContain(otherSource.id);
    expect(radars.length).toBe(radarCountBefore + 1);
    expect(await screen.findByText(`Biến thể của ${original.name}`)).toBeInTheDocument();

    // The original radar is unchanged.
    expect(await api.radarGet(original.id)).toEqual(originalBefore);
  });

  it("applies the plan's field limit to the copy, as for a new radar", async () => {
    const user = userEvent.setup();
    await openRadars(user);
    const original = (await api.radarList())[0]!;
    const license = await api.licenseGet();
    const proposal = await api.radarVariantPrepare(original.id);
    const tooMany = Array.from({ length: license.limits.max_fields_per_radar + 1 }, (_, i) => ({
      ...proposal.input.fields[0]!,
      key: `extra_${i}`,
      order: i + 1,
    }));
    await expect(
      api.radarCreateVariant({
        source_radar_id: original.id,
        input: { ...proposal.input, fields: tooMany },
      })
    ).rejects.toThrow(/trường/);
  });
});
