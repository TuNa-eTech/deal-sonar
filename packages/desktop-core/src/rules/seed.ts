// Port of crates/rules/src/seed.rs.

import { SUPPORTED_DSL_VERSION, type RulesetBody } from "./engine";
import { DEFAULT_MONEY_WINDOW } from "./extractors/money";

export const SEED_BDS_VI_V1 = "bds-vi-v1";

/** Built-in seed ruleset by id (`02-radar-spec.md §7`). */
export function seedRuleset(id: string): RulesetBody | null {
  return id.trim() === SEED_BDS_VI_V1 ? buildBdsViV1() : null;
}

function buildBdsViV1(): RulesetBody {
  return {
    dsl: SUPPORTED_DSL_VERSION,
    prefilter: {
      any: [
        "thue", "mua", "ban", "can ho", "chung cu", "phong", "nha", "mat bang", "dat", "biet thu", "so do", "chinh chu",
        String.raw`re:\b\d+\s*(?:pn|m2)\b`,
      ],
      none: [
        "tuyen dung nhan vien", "tuyen sale bds", "tuyen cong tac vien", "vay von ngan hang", "rut tien the tin dung",
      ],
      min_len: 15,
    },
    classify: [
      {
        id: "reject_broker_inventory",
        when: {
          kw_any: [
            "ben em co quy can", "quy can gia tot", "nhan ky gui", "hoa hong cho moi gioi", "ket hop anh em moi gioi",
          ],
        },
        verdict: "no_match",
        confidence: 0.93,
        set: { author_role: "peer" },
      },
      {
        id: "accept_clear_tenant_demand",
        when: {
          all: [
            { kw_any: ["can thue", "tim thue", "muon thue", "can tim phong", "can tim can ho"] },
            { kw_none: ["cho thue", "chinh chu cho thue", "ben em co", "quy can", "hoa hong", "ky gui", "ib em gui anh"] },
            { has_field: "location" },
          ],
        },
        verdict: "match",
        confidence: 0.92,
        set: { author_role: "end_user", intent: "demand" },
      },
    ],
    extract: [
      {
        field: "deal_type",
        extractor: "enum_kw",
        map: {
          buy: ["can mua", "tim mua", "can ban", "chinh chu ban", "mua", "ban", "sang nhuong"],
          rent: ["can thue", "tim thue", "muon thue", "cho thue", "tim phong", "thue"],
        },
        multi: false,
      },
      {
        field: "property_type",
        extractor: "enum_kw",
        map: {
          apartment: ["chung cu mini", "ccmn", "can ho", "chung cu", "studio", "duplex", "penthouse"],
          commercial: ["mat bang", "van phong", "kho xuong", "cua hang", "shophouse"],
          house: ["nha nguyen can", "nha rieng", "nha mat pho", "nha pho", "biet thu", "lien ke"],
          land: ["dat nen", "dat tho cu", "manh dat", "lo dat"],
          room: ["phong tro", "phong khep kin", "nha tro"],
        },
        multi: false,
      },
      { field: "location", extractor: "gazetteer", dict: "vn_admin", scope: null },
      {
        field: "price",
        extractor: "vn_money",
        near: ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach", "tc", "thue", "mua", "ban"],
        window: DEFAULT_MONEY_WINDOW + 10,
      },
      { field: "area", extractor: "vn_area" },
      {
        field: "bedrooms",
        extractor: "regex",
        pattern: String.raw`(\d+)\s*(?:pn|phong ngu|p\.ngu)\b`,
        group: 1,
        cast: "int",
      },
      { field: "phone", extractor: "vn_phone" },
    ],
    thresholds: { accept: 0.9, reject: 0.9 },
  };
}
