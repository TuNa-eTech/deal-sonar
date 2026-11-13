// Bundled radar templates served by the mock backend.

import type { RadarTemplate } from "../../types/ipc";
import tplBdsKhachThue from "../../../../templates/bds.khach-thue.json";
import tplBdsChinhChu from "../../../../templates/bds.chinh-chu.json";
import tplDichVuTimTho from "../../../../templates/dich-vu.tim-tho.json";
import tplXeCuDuoiGia from "../../../../templates/xe-cu.duoi-gia.json";
import tplTuyenDungTimViec from "../../../../templates/tuyen-dung.tim-viec.json";
import tplVanTaiGhepHang from "../../../../templates/van-tai.ghep-hang.json";
import tplOrderHoiMua from "../../../../templates/order.hoi-mua.json";

export const TEMPLATES: RadarTemplate[] = [
  tplBdsKhachThue as RadarTemplate,
  tplBdsChinhChu as RadarTemplate,
  tplDichVuTimTho as RadarTemplate,
  tplXeCuDuoiGia as RadarTemplate,
  tplTuyenDungTimViec as RadarTemplate,
  tplVanTaiGhepHang as RadarTemplate,
  tplOrderHoiMua as RadarTemplate,
];
