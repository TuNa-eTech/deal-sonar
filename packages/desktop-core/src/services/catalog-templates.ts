// Built-in radar templates (crates/core/src/templates.rs). The seven Rust `include_str!` JSON
// files under apps/desktop/templates are the single source of truth: esbuild/vitest inline them
// here, so there is no second copy to drift. Order matches `EMBEDDED_TEMPLATES`.

import { CoreError } from "../backend/wire";
import { SerdeError } from "./catalog-serde";
import { type RadarTemplateDto, dRadarTemplate } from "./catalog-types";
import bdsKhachThue from "../../../../apps/desktop/templates/bds.khach-thue.json";
import bdsChinhChu from "../../../../apps/desktop/templates/bds.chinh-chu.json";
import tuyenDungTimViec from "../../../../apps/desktop/templates/tuyen-dung.tim-viec.json";
import xeCuDuoiGia from "../../../../apps/desktop/templates/xe-cu.duoi-gia.json";
import vanTaiGhepHang from "../../../../apps/desktop/templates/van-tai.ghep-hang.json";
import dichVuTimTho from "../../../../apps/desktop/templates/dich-vu.tim-tho.json";
import orderHoiMua from "../../../../apps/desktop/templates/order.hoi-mua.json";

const EMBEDDED_TEMPLATES: ReadonlyArray<readonly [string, unknown]> = [
  ["bds.khach-thue", bdsKhachThue],
  ["bds.chinh-chu", bdsChinhChu],
  ["tuyen-dung.tim-viec", tuyenDungTimViec],
  ["xe-cu.duoi-gia", xeCuDuoiGia],
  ["van-tai.ghep-hang", vanTaiGhepHang],
  ["dich-vu.tim-tho", dichVuTimTho],
  ["order.hoi-mua", orderHoiMua],
];

let cache: RadarTemplateDto[] | null = null;

/** `load_templates(None)`: parse (once) and return a fresh copy of all templates. */
export function loadTemplates(): RadarTemplateDto[] {
  if (cache === null) {
    const parsed: RadarTemplateDto[] = [];
    for (const [id, raw] of EMBEDDED_TEMPLATES) {
      try {
        parsed.push(dRadarTemplate(raw));
      } catch (err) {
        if (err instanceof SerdeError) throw new CoreError("json", `lỗi dữ liệu JSON: template ${id}: ${err.message}`);
        throw err;
      }
    }
    cache = parsed;
  }
  return structuredClone(cache);
}

/** `get_template`: the id is trimmed before matching. */
export function getTemplate(id: string): RadarTemplateDto {
  const trimmed = id.trim();
  const found = loadTemplates().find((t) => t.id === trimmed);
  if (!found) throw CoreError.notFound("template", trimmed);
  return found;
}
