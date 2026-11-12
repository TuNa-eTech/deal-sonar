import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FieldType, RadarTemplate } from "../types/ipc";

const TEMPLATES_DIR = path.resolve(__dirname, "../../../templates");

const EXPECTED_TEMPLATES: Record<
  string,
  { industry: string; want_intent: "demand" | "supply" | "any"; seed_ruleset: string | null }
> = {
  "bds.khach-thue.json": {
    industry: "Bất động sản",
    want_intent: "demand",
    seed_ruleset: "bds-vi-v1",
  },
  "bds.chinh-chu.json": {
    industry: "Bất động sản",
    want_intent: "supply",
    seed_ruleset: "bds-vi-v1",
  },
  "dich-vu.tim-tho.json": {
    industry: "Dịch vụ nhà cửa",
    want_intent: "demand",
    seed_ruleset: null,
  },
  "xe-cu.duoi-gia.json": {
    industry: "Xe và đồ cũ",
    want_intent: "supply",
    seed_ruleset: null,
  },
  "tuyen-dung.tim-viec.json": {
    industry: "Tuyển dụng",
    want_intent: "supply",
    seed_ruleset: null,
  },
  "van-tai.ghep-hang.json": {
    industry: "Vận tải, ghép hàng",
    want_intent: "any",
    seed_ruleset: null,
  },
  "order.hoi-mua.json": {
    industry: "Order, bán hàng",
    want_intent: "demand",
    seed_ruleset: null,
  },
};

const ALLOWED_FIELD_TYPES = new Set<FieldType>([
  "text",
  "number",
  "money",
  "phone",
  "location",
  "enum",
  "multi_enum",
  "boolean",
  "date",
  "range",
  "url",
]);

describe("Starter Radar Templates (`02-radar-spec.md §7`)", () => {
  it("contains all 7 required JSON starter templates and matches schema invariants", () => {
    const files = fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();

    expect(files).toEqual(Object.keys(EXPECTED_TEMPLATES).sort());

    for (const filename of files) {
      const expected = EXPECTED_TEMPLATES[filename]!;
      const rawJson = fs.readFileSync(path.join(TEMPLATES_DIR, filename), "utf-8");
      const tpl = JSON.parse(rawJson) as RadarTemplate;

      expect(tpl.id).toBe(filename.replace(/\.json$/, ""));
      expect(tpl.industry).toBe(expected.industry);
      expect(tpl.name.length).toBeGreaterThan(3);
      expect(tpl.user_profession.length).toBeGreaterThan(3);
      expect(tpl.match_policy.want_intent).toBe(expected.want_intent);
      expect(tpl.seed_ruleset).toBe(expected.seed_ruleset);

      // Verify all {placeholder} tokens in description_template match placeholders[]
      const tokensInDesc = Array.from(tpl.description_template.matchAll(/\{([^}]+)\}/g)).map(
        (m) => m[1]
      );
      expect(tokensInDesc.length).toBeGreaterThan(0);
      expect(tpl.placeholders.map((p) => p.key)).toEqual(tokensInDesc);
      for (const ph of tpl.placeholders) {
        expect(ph.hint.length).toBeGreaterThan(2);
      }

      // Verify fields[]
      expect(tpl.fields.length).toBeGreaterThanOrEqual(4);
      expect(tpl.fields.length).toBeLessThanOrEqual(12);
      const seenKeys = new Set<string>();
      tpl.fields.forEach((f, idx) => {
        expect(f.key).toMatch(/^[a-z][a-z0-9_]{1,30}$/);
        expect(seenKeys.has(f.key)).toBe(false);
        seenKeys.add(f.key);

        expect(ALLOWED_FIELD_TYPES.has(f.type)).toBe(true);
        expect(f.label.length).toBeGreaterThan(0);
        expect(f.description.length).toBeGreaterThan(3);
        expect(typeof f.required).toBe("boolean");
        expect(typeof f.show_in_alert).toBe("boolean");
        expect(f.order).toBe(idx + 1);

        if (f.type === "enum" || f.type === "multi_enum") {
          expect(Array.isArray(f.options)).toBe(true);
          expect(f.options!.length).toBeGreaterThanOrEqual(2);
        } else {
          expect(f.options).toBeNull();
        }
      });
    }
  });
});
