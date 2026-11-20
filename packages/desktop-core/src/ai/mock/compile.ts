// Heuristic `compile_rules` response (port of crates/ai-bridge/src/adapters/mock/compile.rs).
// The mock emits a fixed DSL v1 skeleton plus one built-in extractor per recognised field line
// of the radar definition block (`- key (type, required=...): description`).

const RADAR_BLOCK_MARKER = "[1] ĐỊNH NGHĨA RADAR";
const DSL_BLOCK_MARKER = "[2] ĐẶC TẢ DSL";

/** Extractor entry for a prompt field type, or `null` when the type has no built-in mapping. */
function extractorFor(type: string, key: string): Record<string, unknown> | null {
  switch (type) {
    case "money":
      return {
        field: key,
        extractor: "vn_money",
        near: ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach"],
        window: 40,
      };
    case "location":
      return { field: key, extractor: "gazetteer", dict: "vn_admin" };
    case "phone":
      return { field: key, extractor: "vn_phone" };
    case "range":
      return { field: key, extractor: "vn_area" };
    default:
      return null;
  }
}

export function heuristicCompileRules(prompt: string): Record<string, unknown> {
  // Only the radar definition block lists fields; labeled post samples must never add extractors.
  const start = prompt.indexOf(RADAR_BLOCK_MARKER);
  const end = prompt.indexOf(DSL_BLOCK_MARKER);
  const block = start < 0 ? prompt : prompt.slice(start, end > start ? end : undefined);

  const extract: Array<Record<string, unknown>> = [];
  for (const line of block.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const key = line.slice(2).trim().split(/\s+/)[0];
    if (!key) continue;
    for (const type of ["money", "location", "phone", "range"]) {
      if (line.includes(`(${type},`)) {
        const entry = extractorFor(type, key);
        if (entry) extract.push(entry);
        break;
      }
    }
  }

  return {
    dsl: 1,
    prefilter: {
      any: ["can thue", "tim phong", "tim nha", "tim can ho", "muon thue"],
      none: ["tuyen nhan vien kinh doanh", "game bai"],
      min_len: 20,
    },
    classify: [
      {
        id: "r_peer_reject",
        when: { kw_any: ["ben em co", "quy can", "hoa hong", "nhan ky gui"] },
        verdict: "no_match",
        confidence: 0.93,
        set: { author_role: "peer" },
      },
      {
        id: "r_demand_match",
        when: {
          all: [{ kw_any: ["can thue", "tim thue", "muon thue"] }, { kw_none: ["cho thue", "ben em co", "hoa hong"] }],
        },
        verdict: "match",
        confidence: 0.91,
        set: { intent: "demand" },
      },
    ],
    extract,
    thresholds: { accept: 0.9, reject: 0.9 },
  };
}
