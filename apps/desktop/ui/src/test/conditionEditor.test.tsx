import React, { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConditionEditor } from "../components/radar-wizard/ConditionEditor";
import { FilterTraceView } from "../components/radar-wizard/FilterTraceView";
import { countIncomplete, missingFieldKeys, prune, unknownFieldKeys } from "../lib/conditionTree";
import type { FieldDef, FilterExpr, FilterTrace } from "../types/ipc";

const fields: FieldDef[] = [
  { key: "loai_xe", label: "Loại xe", type: "enum", description: "", required: false, options: ["Xe lạnh", "Xe thường"], show_in_alert: true, order: 0 },
  { key: "thung_kin", label: "Thùng kín", type: "boolean", description: "", required: false, options: null, show_in_alert: true, order: 1 },
  { key: "gia", label: "Giá", type: "money", description: "", required: false, options: null, show_in_alert: true, order: 2 },
  { key: "ghi_chu", label: "Ghi chú", type: "text", description: "", required: false, options: null, show_in_alert: true, order: 3 },
];

let latest: FilterExpr | null = null;
function Harness({ initial }: { initial: FilterExpr | null }) {
  const [condition, setCondition] = useState<FilterExpr | null>(initial);
  latest = condition;
  return <ConditionEditor condition={condition} fields={fields} onChange={setCondition} onError={vi.fn()} />;
}

describe("ConditionEditor", () => {
  it("builds “xe lạnh hoặc xe thường có thùng kín” plus an exception without writing JSON", async () => {
    const user = userEvent.setup();
    render(<Harness initial={null} />);
    await user.click(screen.getByRole("button", { name: "+ Thêm nhóm điều kiện" }));

    const root = screen.getByRole("group", { name: "Nhóm điều kiện" });
    expect(within(root).getByLabelText("Nhóm điều kiện: kiểu nhóm")).toHaveValue("any");
    const first = "Nhóm điều kiện › 1";
    await user.selectOptions(screen.getByLabelText(`${first}: trường`), "Loại xe");
    await user.selectOptions(screen.getByLabelText(`${first}: giá trị`), "Xe lạnh");

    await user.click(within(root).getAllByRole("button", { name: "+ Nhóm “tất cả”" })[0]!);
    const second = "Nhóm điều kiện › 2 › 1";
    await user.selectOptions(screen.getByLabelText(`${second}: trường`), "Loại xe");
    await user.selectOptions(screen.getByLabelText(`${second}: giá trị`), "Xe thường");
    await user.click(within(screen.getByRole("group", { name: "Nhóm điều kiện › 2" })).getByRole("button", { name: "+ Điều kiện" }));
    const third = "Nhóm điều kiện › 2 › 2";
    await user.selectOptions(screen.getByLabelText(`${third}: trường`), "Thùng kín");
    await user.selectOptions(screen.getByLabelText(`${third}: giá trị`), "Có");

    const leaf = (field: string, value: unknown) => ({ field, op: "eq", value, when_missing: "fail" });
    expect(latest).toEqual({ any: [leaf("loai_xe", "Xe lạnh"), { all: [leaf("loai_xe", "Xe thường"), leaf("thung_kin", true)] }] });
    expect(screen.getByTestId("condition-summary")).toHaveTextContent(
      "(Loại xe = Xe lạnh HOẶC (Loại xe = Xe thường VÀ Thùng kín = Có))");

    // Exception: exclude posts whose note contains "hỏng máy"; missing note keeps the post.
    await user.click(within(root).getAllByRole("button", { name: "+ Ngoại lệ" }).at(-1)!);
    const exc = "Nhóm điều kiện › 3, điều kiện loại › 1";
    await user.selectOptions(screen.getByLabelText(`${exc}: trường`), "Ghi chú");
    await user.selectOptions(screen.getByLabelText(`${exc}: so sánh`), "Chứa");
    await user.type(screen.getByLabelText(`${exc}: giá trị`), "hỏng máy");
    await user.tab();
    expect(latest).toMatchObject({ any: [expect.anything(), expect.anything(),
      { not: { all: [{ field: "ghi_chu", op: "contains", value: "hỏng máy", when_missing: "fail" }] } }] });

    // Change: switch root to "all"; remove: drop the exception and then the nested group.
    await user.selectOptions(screen.getByLabelText("Nhóm điều kiện: kiểu nhóm"), "all");
    expect(latest).toHaveProperty("all");
    await user.click(screen.getByRole("button", { name: "Bỏ Nhóm điều kiện › 3" }));
    await user.click(screen.getByRole("button", { name: "Bỏ Nhóm điều kiện › 2" }));
    expect(latest).toEqual({ all: [leaf("loai_xe", "Xe lạnh")] });
    await user.click(screen.getByRole("button", { name: `Bỏ ${first}` }));
    expect(latest).toBeNull();
  });

  it("reopens a saved condition with the same visible configuration", () => {
    const saved: FilterExpr = { any: [
      { field: "loai_xe", op: "eq", value: "Xe lạnh", when_missing: "fail" },
      { all: [
        { field: "loai_xe", op: "eq", value: "Xe thường", when_missing: "fail" },
        { field: "thung_kin", op: "eq", value: true, when_missing: "pass" },
      ] },
      { not: { field: "gia", op: "between", value: [1000000, 5000000], when_missing: "fail" } },
    ] };
    render(<Harness initial={saved} />);
    expect(screen.getByLabelText("Nhóm điều kiện › 1: trường")).toHaveValue("loai_xe");
    expect(screen.getByLabelText("Nhóm điều kiện › 1: giá trị")).toHaveValue("Xe lạnh");
    expect(screen.getByLabelText("Nhóm điều kiện › 2 › 2: giá trị")).toHaveValue("yes");
    expect(screen.getByLabelText("Nhóm điều kiện › 2 › 2: khi thiếu thông tin")).toHaveValue("pass");
    expect(screen.getByLabelText("Nhóm điều kiện › 3, điều kiện loại: từ")).toHaveValue("1000000");
    expect(screen.getByLabelText("Nhóm điều kiện › 3, điều kiện loại: đến")).toHaveValue("5000000");
    expect(screen.getByText("Loại bài nếu thỏa (ngoại lệ)")).toBeInTheDocument();
    expect(latest).toEqual(saved);
  });

  it("warns about incomplete conditions and fields that no longer exist", () => {
    const stale: FilterExpr = { any: [
      { field: "da_xoa", op: "eq", value: "x", when_missing: "fail" },
      { field: "gia", op: "lte", value: null, when_missing: "fail" },
    ] };
    render(<Harness initial={stale} />);
    expect(screen.getByRole("alert")).toHaveTextContent("da_xoa");
    expect(screen.getByText(/Còn 1 điều kiện chưa nhập giá trị/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "(trường đã xóa: da_xoa)" })).toBeInTheDocument();
  });
});

describe("conditionTree helpers", () => {
  it("prunes empty groups and exceptions", () => {
    expect(prune({ all: [] })).toBeNull();
    expect(prune({ not: { any: [] } })).toBeNull();
    const leaf = { field: "gia", op: "lte" as const, value: 1, when_missing: "pass" as const };
    expect(prune({ any: [{ all: [] }, leaf] })).toEqual({ any: [leaf] });
    expect(countIncomplete({ all: [leaf, { ...leaf, value: null }] })).toBe(1);
    expect(unknownFieldKeys({ not: { ...leaf, field: "zzz" } }, fields)).toEqual(["zzz"]);
  });
});

describe("FilterTraceView", () => {
  const leaf = (field: string, passed: boolean, over: Partial<FilterTrace> = {}): FilterTrace =>
    ({ kind: "filter", passed, field, op: "eq", value: "x", when_missing: "fail", ...over });
  it("shows passing branch, failing branch, exception and missing fields", () => {
    const trace: FilterTrace = { kind: "all", passed: false, children: [
      { kind: "any", passed: true, children: [
        leaf("loai_xe", false, { value: "Xe lạnh" }),
        { kind: "all", passed: true, children: [leaf("loai_xe", true, { value: "Xe thường" }), leaf("thung_kin", true, { value: true })] },
      ] },
      { kind: "not", passed: false, children: [leaf("ghi_chu", true, { op: "contains", value: "hỏng máy" })] },
      leaf("gia", false, { op: "lte", value: 5000000, missing: true }),
    ] };
    expect(missingFieldKeys(trace)).toEqual(["gia"]);
    render(<FilterTraceView trace={trace} fields={fields} />);
    expect(screen.getByText(/Điều kiện lọc: không đạt · thiếu thông tin: Giá/)).toBeInTheDocument();
    expect(screen.getByText("Có ít nhất một nhánh đạt")).toBeInTheDocument();
    expect(screen.getByText("Bị loại bởi ngoại lệ")).toBeInTheDocument();
    const leaves = screen.getAllByTestId("trace-leaf").map(l => l.textContent);
    expect(leaves[0]).toContain("Loại xe bằng Xe lạnh (không thỏa)");
    expect(leaves[1]).toContain("Loại xe bằng Xe thường (thỏa)");
    expect(leaves[3]).toContain("Ghi chú chứa hỏng máy (thỏa)");
    expect(leaves[4]).toContain("thiếu thông tin → coi là không thỏa");
    expect(leaves[4]).toContain("thiếu «Giá»");
  });
});
