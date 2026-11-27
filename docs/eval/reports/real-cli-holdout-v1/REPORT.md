# Báo cáo chất lượng bằng CLI AI thật trên tập holdout-v1

Issue [#11](https://github.com/TuNa-eTech/deal-sonar/issues/11), phụ thuộc [#10](https://github.com/TuNa-eTech/deal-sonar/issues/10). Sinh bằng `node scripts/eval-study.mjs report`.

> [!WARNING]
> **Đây là số đo trên nhãn nháp một người gán (`draft_single_annotator`) và bài dựng lại (synthetic), chưa phải bài từ nhóm thật.** Kết quả đạt ngưỡng ở đây **chưa đủ** để tuyên bố một nhu cầu được hỗ trợ; cần hoàn tất bằng chứng còn thiếu ở [holdout README §6](../../holdout/README.md) (người gán nhãn độc lập thứ hai, mẫu thật đã ẩn danh).

## 1. Cấu hình đo

| Cấu hình (thư mục) | Provider | Phiên bản CLI | Model báo cáo bởi CLI | Model chỉ định | Lô | Lượt hoàn thành/yêu cầu theo Radar |
|---|---|---|---|---|---:|---:|
| `claude__haiku` | claude_cli | 2.1.332 (Claude Code) | claude-haiku-5-5 | haiku | 20 | 3/3, 3/3, 3/3 |
| `claude__sonnet` | claude_cli | 2.1.332 (Claude Code) | claude-sonnet-5-5 | sonnet | 20 | 3/3, 3/3, 3/3 |
| `codex__gpt-6.2-sol__b10` | codex_cli | codex-cli 0.172.0 | gpt-6.2-sol | gpt-6.2-sol | 10 | 3/3 |

| Radar | `radar_version_id` | Tập bài | Dấu vân tay (FNV-1a 64) | Số bài |
|---|---|---|---|---:|
| `bds-tim-nguoi-thue` | `01HOLDOUTBDSTENANTV1` | `docs/eval/holdout/bds-tim-nguoi-thue.jsonl` | `e3c24ce13c7abda4` | 55 |
| `bds-tim-chu-nha` | `01HOLDOUTBDSOWNERV1` | `docs/eval/holdout/bds-tim-chu-nha.jsonl` | `e02575b6b9e3e686` | 55 |
| `gia-su-phu-huynh` | `01HOLDOUTTUTORV1` | `docs/eval/holdout/gia-su-phu-huynh.jsonl` | `a2a1ec30b602e289` | 41 |

Ngưỡng của issue: **precision ≥ 85%**, **recall ≥ 90%**, **mỗi trường bắt buộc ≥ 90%**. Ngưỡng H2 còn lại (peer ≥ 75%, trường tuỳ chọn ≥ 80%, bịa `raw` ≤ 1%, ổn định ≤ 3%) báo cáo ở mục 4.
Một cổng chỉ ghi **ĐẠT** khi đạt ở **mọi** lượt lặp; cột "gộp" cộng tử số và mẫu số của mọi lượt.

## 2. Kết quả theo Radar (ba cổng của issue)

### `claude__haiku` × `bds-tim-nguoi-thue`

| Phép đo | Ngưỡng | Lượt 1 | Lượt 2 | Lượt 3 | Gộp | Kết luận |
|---|---:|---|---|---|---|---|
| match_precision | ≥ 85% | 13/13 = 100,00% | 13/13 = 100,00% | 13/13 = 100,00% | 39/39 = 100,00% | ĐẠT |
| match_recall | ≥ 90% | 13/14 = 92,86% | 13/14 = 92,86% | 13/14 = 92,86% | 39/42 = 92,86% | ĐẠT |
| field:location | ≥ 90% | 6/14 = 42,86% | 6/14 = 42,86% | 6/14 = 42,86% | 18/42 = 42,86% | **CHƯA ĐẠT** |
| field:property_type | ≥ 90% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |

### `claude__haiku` × `bds-tim-chu-nha`

| Phép đo | Ngưỡng | Lượt 1 | Lượt 2 | Lượt 3 | Gộp | Kết luận |
|---|---:|---|---|---|---|---|
| match_precision | ≥ 85% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |
| match_recall | ≥ 90% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |
| field:location | ≥ 90% | 7/14 = 50,00% | 7/14 = 50,00% | 0/14 = 0,00% | 14/42 = 33,33% | **CHƯA ĐẠT** |
| field:property_type | ≥ 90% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |

### `claude__haiku` × `gia-su-phu-huynh`

| Phép đo | Ngưỡng | Lượt 1 | Lượt 2 | Lượt 3 | Gộp | Kết luận |
|---|---:|---|---|---|---|---|
| match_precision | ≥ 85% | 13/13 = 100,00% | 12/12 = 100,00% | 13/13 = 100,00% | 38/38 = 100,00% | ĐẠT |
| match_recall | ≥ 90% | 13/13 = 100,00% | 12/13 = 92,31% | 13/13 = 100,00% | 38/39 = 97,44% | ĐẠT |
| field:subject | ≥ 90% | 13/13 = 100,00% | 13/13 = 100,00% | 13/13 = 100,00% | 39/39 = 100,00% | ĐẠT |

### `claude__sonnet` × `bds-tim-nguoi-thue`

| Phép đo | Ngưỡng | Lượt 1 | Lượt 2 | Lượt 3 | Gộp | Kết luận |
|---|---:|---|---|---|---|---|
| match_precision | ≥ 85% | 13/13 = 100,00% | 13/13 = 100,00% | 13/13 = 100,00% | 39/39 = 100,00% | ĐẠT |
| match_recall | ≥ 90% | 13/14 = 92,86% | 13/14 = 92,86% | 13/14 = 92,86% | 39/42 = 92,86% | ĐẠT |
| field:location | ≥ 90% | 6/14 = 42,86% | 7/14 = 50,00% | 6/14 = 42,86% | 19/42 = 45,24% | **CHƯA ĐẠT** |
| field:property_type | ≥ 90% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |

### `claude__sonnet` × `bds-tim-chu-nha`

| Phép đo | Ngưỡng | Lượt 1 | Lượt 2 | Lượt 3 | Gộp | Kết luận |
|---|---:|---|---|---|---|---|
| match_precision | ≥ 85% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |
| match_recall | ≥ 90% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |
| field:location | ≥ 90% | 7/14 = 50,00% | 7/14 = 50,00% | 7/14 = 50,00% | 21/42 = 50,00% | **CHƯA ĐẠT** |
| field:property_type | ≥ 90% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |

### `claude__sonnet` × `gia-su-phu-huynh`

| Phép đo | Ngưỡng | Lượt 1 | Lượt 2 | Lượt 3 | Gộp | Kết luận |
|---|---:|---|---|---|---|---|
| match_precision | ≥ 85% | 13/13 = 100,00% | 13/13 = 100,00% | 13/13 = 100,00% | 39/39 = 100,00% | ĐẠT |
| match_recall | ≥ 90% | 13/13 = 100,00% | 13/13 = 100,00% | 13/13 = 100,00% | 39/39 = 100,00% | ĐẠT |
| field:subject | ≥ 90% | 13/13 = 100,00% | 13/13 = 100,00% | 13/13 = 100,00% | 39/39 = 100,00% | ĐẠT |

### `codex__gpt-6.2-sol__b10` × `bds-tim-nguoi-thue`

| Phép đo | Ngưỡng | Lượt 1 | Lượt 2 | Lượt 3 | Gộp | Kết luận |
|---|---:|---|---|---|---|---|
| match_precision | ≥ 85% | 13/13 = 100,00% | 13/13 = 100,00% | 11/11 = 100,00% | 37/37 = 100,00% | ĐẠT |
| match_recall | ≥ 90% | 13/14 = 92,86% | 13/14 = 92,86% | 11/14 = 78,57% | 37/42 = 88,10% | **CHƯA ĐẠT** |
| field:location | ≥ 90% | 5/14 = 35,71% | 6/14 = 42,86% | 6/14 = 42,86% | 17/42 = 40,48% | **CHƯA ĐẠT** |
| field:property_type | ≥ 90% | 14/14 = 100,00% | 14/14 = 100,00% | 14/14 = 100,00% | 42/42 = 100,00% | ĐẠT |

## 3. Ổn định qua các lượt lặp

Ngưỡng: tỉ lệ bài đổi quyết định khớp giữa các lượt ≤ 3% ([validation plan §3.2](../../../delivery/02-validation-plan.md)).

| Cấu hình | Radar | Số lượt | Bài đổi quyết định | Tỉ lệ | Kết luận | Bài đổi |
|---|---|---:|---:|---:|---|---|
| `claude__haiku` | `bds-tim-nguoi-thue` | 3 | 0/55 | 0,00% | ĐẠT | — |
| `claude__haiku` | `bds-tim-chu-nha` | 3 | 0/55 | 0,00% | ĐẠT | — |
| `claude__haiku` | `gia-su-phu-huynh` | 3 | 1/41 | 2,44% | ĐẠT | `hg-005` |
| `claude__sonnet` | `bds-tim-nguoi-thue` | 3 | 0/55 | 0,00% | ĐẠT | — |
| `claude__sonnet` | `bds-tim-chu-nha` | 3 | 0/55 | 0,00% | ĐẠT | — |
| `claude__sonnet` | `gia-su-phu-huynh` | 3 | 0/41 | 0,00% | ĐẠT | — |
| `codex__gpt-6.2-sol__b10` | `bds-tim-nguoi-thue` | 3 | 2/55 | 3,64% | **CHƯA ĐẠT** | `hb-005`, `hb-009` |

## 4. Các ngưỡng H2 còn lại (gộp mọi lượt)

| Cấu hình | Radar | Peer precision | Peer recall | Trường tuỳ chọn kém nhất | Bịa `raw` |
|---|---|---|---|---|---|
| `claude__haiku` | `bds-tim-nguoi-thue` | 36/45 = 80,00% | 36/36 = 100,00% | field:bedrooms 39/42 = 92,86% | 1/601 = 0,17% |
| `claude__haiku` | `bds-tim-chu-nha` | 42/45 = 93,33% | 42/42 = 100,00% | field:bedrooms 42/42 = 100,00% | 0/552 = 0,00% |
| `claude__haiku` | `gia-su-phu-huynh` | 27/27 = 100,00% | 27/27 = 100,00% | field:location 27/39 = 69,23% ⚠ | 1/359 = 0,28% |
| `claude__sonnet` | `bds-tim-nguoi-thue` | 36/50 = 72,00% ⚠ | 36/36 = 100,00% | field:bedrooms 39/42 = 92,86% | 0/466 = 0,00% |
| `claude__sonnet` | `bds-tim-chu-nha` | 42/44 = 95,45% | 42/42 = 100,00% | field:bedrooms 42/42 = 100,00% | 0/609 = 0,00% |
| `claude__sonnet` | `gia-su-phu-huynh` | 27/27 = 100,00% | 27/27 = 100,00% | field:location 27/39 = 69,23% ⚠ | 0/365 = 0,00% |
| `codex__gpt-6.2-sol__b10` | `bds-tim-nguoi-thue` | 36/52 = 69,23% ⚠ | 36/36 = 100,00% | field:bedrooms 39/42 = 92,86% | 0/584 = 0,00% |

## 5. Số lần gọi và hạn mức tiêu thụ

Số liệu do CLI báo cáo trong phong bì JSON. `cost_usd` chỉ có khi CLI trả về; với gói thuê bao đó là mức quy đổi, không phải tiền thật phải trả. n/a = CLI không báo cáo.

| Cấu hình | Radar | Lời gọi | Lời gọi lỗi | Chia đôi lô | Token vào | Token ra | Chi phí quy đổi (USD) | Thời gian CLI |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `claude__haiku` | `bds-tim-nguoi-thue` | 9 | 0 | 0 | 103169 | 193243 | 0.1133 | 12.8 phút |
| `claude__haiku` | `bds-tim-chu-nha` | 9 | 0 | 0 | 176634 | 204906 | 0.1259 | 13.1 phút |
| `claude__haiku` | `gia-su-phu-huynh` | 9 | 0 | 0 | 103057 | 136674 | 0.0841 | 9.3 phút |
| **`claude__haiku` cộng** | | **27** | **0** | **0** | **382860** | **534823** | **0.3233** | **35.2 phút** |
| `claude__sonnet` | `bds-tim-nguoi-thue` | 9 | 0 | 0 | 82647 | 64900 | 0.9300 | 6.9 phút |
| `claude__sonnet` | `bds-tim-chu-nha` | 9 | 0 | 0 | 84015 | 69681 | 0.9796 | 7.0 phút |
| `claude__sonnet` | `gia-su-phu-huynh` | 9 | 0 | 0 | 73944 | 46892 | 0.7101 | 4.8 phút |
| **`claude__sonnet` cộng** | | **27** | **0** | **0** | **240606** | **181473** | **2.6196** | **18.6 phút** |
| `codex__gpt-6.2-sol__b10` | `bds-tim-nguoi-thue` | 18 | 0 | 0 | 550327 | 48274 | n/a | 18.3 phút |
| **`codex__gpt-6.2-sol__b10` cộng** | | **18** | **0** | **0** | **550327** | **48274** | **n/a** | **18.3 phút** |

## 6. Ví dụ lỗi đã ẩn danh

Văn bản lấy nguyên từ tập holdout (đã ẩn danh: bí danh, số điện thoại giả dải `09xx.000.xxx`). Lỗi được nhóm theo bài; "lặp" là số lượt (trên tổng) mà cùng lỗi xuất hiện.

### `claude__haiku` × `bds-tim-nguoi-thue` — 14 lỗi khác nhau

Theo loại: trích sai trường 9; bỏ sót bài khớp 1; gán nhầm là người cùng nghề 3; bịa `raw` 1.

| Bài | Loại | Trường | Kỳ vọng | AI trả về | Lặp | Văn bản (rút gọn) | Lý do AI nêu |
|---|---|---|---|---|---:|---|---|
| `hb-002` | trích sai trường | location | `{"district":"Bình Thạnh","province":"TP. Hồ Chí Minh"}` | `{"district":"Bình Thạnh","province":"Hồ Chí Minh","raw":"q binh thanh","ward":null}` | 3/3 | can thue phong tro khep kin q binh thanh gan hutech gia 3tr-4tr5 sdt o909 000 102 | Người thật cần thuê phòng trọ khép kín ở Bình Thạnh (TP.HCM), có ngân sách và SĐT (gõ 'o909'); không phải môi… |
| `hb-003` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"Hồ Chí Minh","raw":"Quận 7","ward":null}` | 3/3 | Cần thuê chung cư 2pn Quận 7 13tr 0909000103 | Người thật cần thuê căn hộ 2PN ở Quận 7 (TP.HCM), có ngân sách và SĐT; không phải chủ nhà hay môi giới. |
| `hb-006` | bỏ sót bài khớp | — | `true` | `false` | 3/3 | Cần thuê căn hộ 1pn gần trường ĐH, giá tầm 8tr, nhắn mình qua Zalo 0909.000.106 | Nhu cầu thuê thật nhưng bài không nêu Hà Nội hay TP.HCM (chỉ ghi 'gần trường ĐH'), nên không đủ điều kiện khu… |
| `hb-007` | trích sai trường | location | `{"district":"Tân Bình","province":"TP. Hồ Chí Minh"}` | `{"district":"Tân Bình","province":"Hồ Chí Minh","raw":"khu Tân Bình","ward":null}` | 3/3 | 🙏🙏 Vợ chồng mới cưới e cần thuê chung cư 1pn khu Tân Bình tc 8 củ/tháng ạ, ai có nhắn e zalo 0909.000.107 🏠💕 | Cặp vợ chồng thật cần thuê căn hộ 1PN ở Tân Bình (TP.HCM), có ngân sách và SĐT; không phải chủ nhà hay môi gi… |
| `hb-008` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"Hồ Chí Minh","raw":"District 7 HCMC","ward":null}` | 3/3 | Hi all, I'm looking to rent a studio in District 7 HCMC, budget 10-12tr per month, pls PM or call 0909.000.108 | Genuine tenant seeking a studio in District 7 HCMC with stated budget and phone; not a landlord or broker. |
| `hb-009` | trích sai trường | location | `null` | `{"district":null,"province":"Hà Nội","raw":"gần ĐH Bách Khoa","ward":null}` | 3/3 | Cần thuê phòng trọ gần ĐH Bách Khoa, sinh viên nữ, giá 2tr5-3tr, ưu tiên khép kín. Zalo 0909.000.109 | Người thuê phòng trọ thật (sinh viên nữ). 'ĐH Bách Khoa' có thể ở HN hoặc HCM; nhóm là Hà Nội nên tạm chấp nh… |
| `hb-010` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"Hồ Chí Minh","raw":"khu Gò Vấp","ward":null}` | 3/3 | Gia đình 4 người cần thuê nhà nguyên căn 2 tầng khu Gò Vấp, 4 phòng ngủ, 14-16tr/tháng, thuê dài hạn 2 năm. 0909.000.110 | Gia đình thật cần thuê nhà nguyên căn 4PN ở Gò Vấp (TP.HCM), thuê dài hạn; có ngân sách và SĐT rõ ràng. |
| `hb-012` | trích sai trường | bedrooms | `null` | `1` | 3/3 | Mình là nhân viên văn phòng, cần thuê studio hoặc căn 1pn khu Hai Bà Trưng, tầm 7-9tr/th, có thang máy. Zalo 0909.000.112 | Người thật (nhân viên văn phòng) cần thuê studio/1PN ở Hai Bà Trưng (Hà Nội theo nhóm); ngân sách và SĐT rõ r… |
| `hb-013` | trích sai trường | location | `{"district":"Thủ Đức","province":"TP. Hồ Chí Minh"}` | `{"district":"Thủ Đức","province":"Hồ Chí Minh","raw":"Thủ Đức","ward":null}` | 3/3 | Em cần thuê căn hộ 3pn Thủ Đức cho gia đình có con nhỏ, 15-18tr, gần trường học. 0909.000.113 | Gia đình thật cần thuê căn hộ 3PN ở Thủ Đức (TP.HCM), có ngân sách và SĐT; không phải chủ nhà hay môi giới. |
| `hb-038` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 3/3 | Công ty quản lý vận hành căn hộ dịch vụ nhận ký gửi và quản lý căn hộ cho chủ nhà tại Hà Nội, cam kết lấp đầy 95%, hợp tác lâu dài. Liên hệ 0909.000.… | Doanh nghiệp quản lý/ký gửi căn hộ cho chủ, là người cùng nghề đang tìm nguồn hàng. Không phải người cần thuê… |
| `hb-039` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 3/3 | Nhận quản lý toàn diện nhà cho thuê (thu tiền, sửa chữa, tìm khách) tại TP.HCM, phí 8% doanh thu, ai có nhà trống liên hệ 0909.000.602 | Dịch vụ quản lý nhà cho thuê thu phí 8% doanh thu, tìm nhà trống: người cùng nghề, không phải khách cần thuê.… |
| `hb-040` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 3/3 | Dịch vụ dọn dẹp, vệ sinh căn hộ cho thuê giữa hai khách thuê, giá 150k/giờ khu Cầu Giấy, Thanh Xuân 0909.000.603 | Thợ dọn dẹp chào dịch vụ cho căn hộ cho thuê: người cùng nghề/thợ, không phải người cần thuê. Không khớp rada… |

### `claude__haiku` × `bds-tim-chu-nha` — 15 lỗi khác nhau

Theo loại: trích sai trường 14; gán nhầm là người cùng nghề 1.

| Bài | Loại | Trường | Kỳ vọng | AI trả về | Lặp | Văn bản (rút gọn) | Lý do AI nêu |
|---|---|---|---|---|---:|---|---|
| `hb-016` | trích sai trường | location | `{"district":"Bình Thạnh","province":"TP. Hồ Chí Minh"}` | `{"district":"Bình Thạnh","province":"TP.HCM","raw":"q Binh Thanh","ward":null}` | 3/3 | chinh chu cho thue nha nguyen can 1 tret 2 lau q Binh Thanh 4pn gia 20tr, de xe oto thoai mai, lh 0909.000.203 | Tự nhận 'chinh chu', cho thuê nhà nguyên căn ở Bình Thạnh (TP.HCM), có số phòng ngủ, giá và SĐT. Khớp định ng… |
| `hb-018` | trích sai trường | location | `{"district":"Thủ Đức","province":"TP. Hồ Chí Minh"}` | `{"district":"Thủ Đức","province":"TP.HCM","raw":"Thủ Đức","ward":null}` | 3/3 | Cho thuê căn hộ 3pn 95m2 Thủ Đức view sông, giá thương lượng cho người thuê lâu dài. Chủ nhà 0909.000.205 | 'Chủ nhà' cho thuê căn hộ 3PN ở Thủ Đức (TP.HCM), có SĐT chủ nhà. Giá thương lượng nên không có số tiền. Khớp… |
| `hb-019` | trích sai trường | location | `{"district":"Tân Bình","province":"TP. Hồ Chí Minh"}` | `{"district":"Tân Bình","province":"TP.HCM","raw":"Tân Bình","ward":null}` | 3/3 | 🏠 Chính chủ cho thuê căn hộ 1pn Tân Bình, có ban công, tc 7tr5/th ✅ nội thất cơ bản ✅ gần sân bay. Zalo 0909.000.206 | Tự nhận 'Chính chủ', cho thuê căn hộ 1PN ở Tân Bình (TP.HCM), có giá và SĐT. Nội thất 'cơ bản' nên suy ra là … |
| `hb-020` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"TP.HCM","raw":"District 7","ward":null}` | 3/3 | Owner renting out a 2BR apartment in District 7, 14tr/month, furnished, available now. Call 0909.000.207 | Owner renting out a 2BR furnished apartment in District 7 (HCMC), 14M/month, with phone. Matches supply; prov… |
| `hb-022` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"Gò Vấp","ward":null}` | 3/3 | Cho thuê phòng 20m2 Gò Vấp 2tr5 0909.000.209 | Cho thuê phòng tại Gò Vấp (TP.HCM), có giá và SĐT. Không rõ là chủ hay người môi giới, không thấy dấu hiệu mô… |
| `hb-023` | trích sai trường | location | `{"district":"Quận 1","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 1","province":"TP.HCM","raw":"quận 1","ward":null}` | 3/3 | Nhà có 1 phòng trống tầng 3 quận 1 cho thuê 6tr/tháng, phù hợp nữ, giờ giấc tự do, ib mình 0909.000.210 | Bài của chủ nhà có phòng trống tự cho thuê, Quận 1 (TP.HCM), không có dấu hiệu môi giới hay mời cộng tác. |
| `hb-040` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 3/3 | Dịch vụ dọn dẹp, vệ sinh căn hộ cho thuê giữa hai khách thuê, giá 150k/giờ khu Cầu Giấy, Thanh Xuân 0909.000.603 | Nhà cung cấp dịch vụ vệ sinh giữa các khách thuê, thuộc ngành vận hành nhà cho thuê; không phải chủ nhà và kh… |
| `hb-045` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"Gò Vấp","ward":null}` | 3/3 | Mình là chủ nhà, tìm khách thuê phòng trọ Gò Vấp 3tr, vào ở ngay 0909.000.802 | Tự nhận là chủ nhà, cho thuê phòng trọ tại Gò Vấp TP.HCM; thiếu diện tích và nội thất nhưng vẫn khớp radar. |
| `hb-014` | trích sai trường | location | `{"district":"Cầu Giấy","province":"Hà Nội"}` | `{"district":"Cầu Giấy","province":null,"raw":"khu Cầu Giấy","ward":null}` | 1/3 | Chính chủ cho thuê căn hộ 2pn 70m2 full nội thất khu Cầu Giấy, 13tr/tháng, hợp đồng 1 năm, miễn trung gian. LH 0909.000.201 | Tự nhận chính chủ, không qua trung gian, cho thuê căn hộ 2PN nội thất ở Cầu Giấy (Hà Nội theo tên nhóm). Khớp… |
| `hb-015` | trích sai trường | location | `{"district":"Hà Đông","province":"Hà Nội"}` | `{"district":"Hà Đông","province":null,"raw":"ngõ 12 Hà Đông","ward":null}` | 1/3 | Chủ nhà cho thuê phòng trọ khép kín 25m2 ngõ 12 Hà Đông 2tr8/tháng, điện nước giá nhà nước, không chung chủ. 0909.000.202 | Tự nhận chủ nhà, không chung chủ, cho thuê phòng trọ tại Hà Đông (Hà Nội theo tên nhóm). Không thấy dấu hiệu … |
| `hb-017` | trích sai trường | location | `{"district":"Thanh Xuân","province":"Hà Nội"}` | `{"district":"Thanh Xuân","province":null,"raw":"khu Thanh Xuân","ward":null}` | 1/3 | Nhà mình còn trống 1 căn studio khu Thanh Xuân, nội thất đầy đủ, ai cần thì inbox. | Tự nói "Nhà mình còn trống" nên là chủ nhà, nhưng không ghi rõ chính chủ và không có SĐT. Khớp ở mức vừa. |
| `hb-021` | trích sai trường | location | `{"district":"Đống Đa","province":"Hà Nội"}` | `{"district":"Đống Đa","province":null,"raw":"Đống Đa","ward":null}` | 1/3 | Gia đình mình chuyển công tác nên cho thuê lại nhà riêng 3 tầng ở Đống Đa, 18tr/tháng, ưu tiên hộ gia đình. 0909.000.208 | Chủ nhà tự đăng (chuyển công tác), nhà nguyên căn có giá và SĐT, không có dấu hiệu môi giới. Bài không nêu tỉ… |

### `claude__haiku` × `gia-su-phu-huynh` — 6 lỗi khác nhau

Theo loại: trích sai trường 4; bỏ sót bài khớp 1; bịa `raw` 1.

| Bài | Loại | Trường | Kỳ vọng | AI trả về | Lặp | Văn bản (rút gọn) | Lý do AI nêu |
|---|---|---|---|---|---:|---|---|
| `hg-003` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"quận 7","province":"TP.HCM","raw":"quan 7","ward":null}` | 3/3 | can tim gia su ly 11 on thi hsg, hoc tai nha quan 7, sdt 0909.000.113 | Phụ huynh tìm gia sư Vật lý lớp 11 học tại nhà quận 7 (TP.HCM), có SĐT; khớp. Chưa nêu học phí. |
| `hg-008` | trích sai trường | location | `{"district":"Tân Bình","province":"TP. Hồ Chí Minh"}` | `{"district":"Tân Bình","province":"TP.HCM","raw":"khu Tân Bình","ward":null}` | 3/3 | Nhờ mọi người giới thiệu giúp trung tâm hoặc gia sư kèm toán lớp 7 cho con, khu Tân Bình, ưu tiên dạy 1-1, 0909.000.118 | Phụ huynh tìm gia sư/trung tâm dạy Toán lớp 7 ở Tân Bình (TP.HCM), là nhu cầu chứ không phải quảng cáo; khớp.… |
| `hg-010` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"quận Gò Vấp","ward":null}` | 3/3 | Con mình lớp 5 yếu toán, tìm sinh viên sư phạm dạy kèm cuối tuần quận Gò Vấp, học phí thoả thuận | Phụ huynh tìm gia sư Toán lớp 5 khu Gò Vấp (TP.HCM); khớp. Học phí thoả thuận, hình thức học chưa nêu. |
| `hg-013` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"khu Gò Vấp","ward":null}` | 3/3 | Cần gia sư tiếng Anh lớp 8 học tại nhà khu Gò Vấp, bé mất gốc, 250k/buổi, zalo 0909.000.124 | Nhu cầu tiếng Anh lớp 8 tại nhà Gò Vấp (TP.HCM), có học phí và SĐT; khớp. |
| `hg-005` | bỏ sót bài khớp | — | `true` | `false` | 1/3 | Cần gia sư IELTS target 6.5 cho em học lớp 12, học online buổi tối, ngân sách 300k/buổi, 0909.000.115 | Nhu cầu luyện IELTS 6.5 là chứng chỉ ngoài chương trình phổ thông, dù thuộc môn tiếng Anh; ranh giới sát nên … |
| `hg-013` | bịa `raw` | — | `null` | `0924.000.124` | 1/3 | Cần gia sư tiếng Anh lớp 8 học tại nhà khu Gò Vấp, bé mất gốc, 250k/buổi, zalo 0909.000.124 | Nhu cầu tiếng Anh lớp 8 tại nhà Gò Vấp (TP.HCM), có học phí và SĐT; khớp. |

### `claude__sonnet` × `bds-tim-nguoi-thue` — 20 lỗi khác nhau

Theo loại: trích sai trường 9; bỏ sót bài khớp 1; gán nhầm là người cùng nghề 10.

| Bài | Loại | Trường | Kỳ vọng | AI trả về | Lặp | Văn bản (rút gọn) | Lý do AI nêu |
|---|---|---|---|---|---:|---|---|
| `hb-002` | trích sai trường | location | `{"district":"Bình Thạnh","province":"TP. Hồ Chí Minh"}` | `{"district":"Bình Thạnh","province":"TP.HCM","raw":"q binh thanh","ward":null}` | 3/3 | can thue phong tro khep kin q binh thanh gan hutech gia 3tr-4tr5 sdt o909 000 102 | Cần thuê phòng trọ ở Bình Thạnh gần Hutech, có ngân sách; giống người thuê thật. |
| `hb-003` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"TP.HCM","raw":"Quận 7","ward":null}` | 3/3 | Cần thuê chung cư 2pn Quận 7 13tr 0909000103 | Nhu cầu thuê chung cư tại Quận 7 rõ ràng; bài ngắn, không có dấu hiệu môi giới. |
| `hb-006` | bỏ sót bài khớp | — | `true` | `false` | 3/3 | Cần thuê căn hộ 1pn gần trường ĐH, giá tầm 8tr, nhắn mình qua Zalo 0909.000.106 | Có nhu cầu thuê thật nhưng không nêu thành phố, trường hay quận; không xác định được có thuộc Hà Nội/TP.HCM. |
| `hb-007` | trích sai trường | location | `{"district":"Tân Bình","province":"TP. Hồ Chí Minh"}` | `{"district":"Tân Bình","province":"TP.HCM","raw":"khu Tân Bình","ward":null}` | 3/3 | 🙏🙏 Vợ chồng mới cưới e cần thuê chung cư 1pn khu Tân Bình tc 8 củ/tháng ạ, ai có nhắn e zalo 0909.000.107 🏠💕 | Vợ chồng mới cưới tự tìm nhà để ở tại Tân Bình, là người thuê thật. |
| `hb-008` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"TP.HCM","raw":"District 7 HCMC","ward":null}` | 3/3 | Hi all, I'm looking to rent a studio in District 7 HCMC, budget 10-12tr per month, pls PM or call 0909.000.108 | Người đăng tự tìm thuê studio ở Quận 7, có ngân sách và số liên hệ. |
| `hb-009` | trích sai trường | location | `null` | `{"district":"Hai Bà Trưng","province":"Hà Nội","raw":"gần ĐH Bách Khoa","ward":null}` | 3/3 | Cần thuê phòng trọ gần ĐH Bách Khoa, sinh viên nữ, giá 2tr5-3tr, ưu tiên khép kín. Zalo 0909.000.109 | Sinh viên cần phòng trọ; địa điểm suy ra là Hà Nội từ ĐH Bách Khoa và nhóm Hà Nội. |
| `hb-010` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"khu Gò Vấp","ward":null}` | 3/3 | Gia đình 4 người cần thuê nhà nguyên căn 2 tầng khu Gò Vấp, 4 phòng ngủ, 14-16tr/tháng, thuê dài hạn 2 năm. 0909.000.110 | Gia đình cần thuê nhà ở dài hạn tại Gò Vấp, là người thuê thật. |
| `hb-012` | trích sai trường | bedrooms | `null` | `1` | 3/3 | Mình là nhân viên văn phòng, cần thuê studio hoặc căn 1pn khu Hai Bà Trưng, tầm 7-9tr/th, có thang máy. Zalo 0909.000.112 | Người đi làm tự tìm chỗ ở tại Hai Bà Trưng, chấp nhận studio hoặc 1PN. |
| `hb-013` | trích sai trường | location | `{"district":"Thủ Đức","province":"TP. Hồ Chí Minh"}` | `{"district":"Thủ Đức","province":"TP.HCM","raw":"Thủ Đức","ward":null}` | 3/3 | Em cần thuê căn hộ 3pn Thủ Đức cho gia đình có con nhỏ, 15-18tr, gần trường học. 0909.000.113 | Gia đình có con nhỏ cần thuê căn hộ để ở tại Thủ Đức. |
| `hb-038` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 3/3 | Công ty quản lý vận hành căn hộ dịch vụ nhận ký gửi và quản lý căn hộ cho chủ nhà tại Hà Nội, cam kết lấp đầy 95%, hợp tác lâu dài. Liên hệ 0909.000.… | Doanh nghiệp cùng ngành chào dịch vụ cho chủ nhà, không có nhu cầu thuê ở. |
| `hb-039` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 3/3 | Nhận quản lý toàn diện nhà cho thuê (thu tiền, sửa chữa, tìm khách) tại TP.HCM, phí 8% doanh thu, ai có nhà trống liên hệ 0909.000.602 | Chào dịch vụ quản lý cho chủ có nhà trống, không phải người cần thuê. |
| `hb-046` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"Hồ Chí Minh","raw":"Gò Vấp","ward":null}` | 2/3 | Cần tìm chủ nhà cho thuê phòng trọ khu Gò Vấp, giá khoảng 2tr5-3tr, ưu tiên không chung chủ. Zalo 0909.000.803 | Người thuê tìm chủ nhà, nêu ngân sách và ưu tiên cá nhân; không có dấu hiệu môi giới. |

### `claude__sonnet` × `bds-tim-chu-nha` — 8 lỗi khác nhau

Theo loại: trích sai trường 7; gán nhầm là người cùng nghề 1.

| Bài | Loại | Trường | Kỳ vọng | AI trả về | Lặp | Văn bản (rút gọn) | Lý do AI nêu |
|---|---|---|---|---|---:|---|---|
| `hb-016` | trích sai trường | location | `{"district":"Bình Thạnh","province":"TP. Hồ Chí Minh"}` | `{"district":"Bình Thạnh","province":"TP.HCM","raw":"q Binh Thanh","ward":null}` | 3/3 | chinh chu cho thue nha nguyen can 1 tret 2 lau q Binh Thanh 4pn gia 20tr, de xe oto thoai mai, lh 0909.000.203 | Ghi rõ 'chinh chu cho thue' nhà nguyên căn tại Bình Thạnh, TP.HCM. |
| `hb-018` | trích sai trường | location | `{"district":"Thủ Đức","province":"TP. Hồ Chí Minh"}` | `{"district":"Thủ Đức","province":"TP.HCM","raw":"Thủ Đức","ward":null}` | 3/3 | Cho thuê căn hộ 3pn 95m2 Thủ Đức view sông, giá thương lượng cho người thuê lâu dài. Chủ nhà 0909.000.205 | Chủ nhà cho thuê căn hộ tại Thủ Đức, tự xưng 'Chủ nhà'; giá chỉ ghi thương lượng. |
| `hb-019` | trích sai trường | location | `{"district":"Tân Bình","province":"TP. Hồ Chí Minh"}` | `{"district":"Tân Bình","province":"TP.HCM","raw":"Tân Bình","ward":null}` | 3/3 | 🏠 Chính chủ cho thuê căn hộ 1pn Tân Bình, có ban công, tc 7tr5/th ✅ nội thất cơ bản ✅ gần sân bay. Zalo 0909.000.206 | Chính chủ cho thuê căn hộ tại Tân Bình; emoji trang trí nhưng không có dấu hiệu môi giới. |
| `hb-020` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"TP.HCM","raw":"District 7","ward":null}` | 3/3 | Owner renting out a 2BR apartment in District 7, 14tr/month, furnished, available now. Call 0909.000.207 | Author states 'Owner renting out' an apartment in District 7, HCMC; no agent signals. |
| `hb-022` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"Gò Vấp","ward":null}` | 3/3 | Cho thuê phòng 20m2 Gò Vấp 2tr5 0909.000.209 | Tin cho thuê phòng đơn lẻ, không có dấu hiệu môi giới; bài quá ngắn nên chưa chắc là chính chủ. |
| `hb-023` | trích sai trường | location | `{"district":"Quận 1","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 1","province":"TP.HCM","raw":"quận 1","ward":null}` | 3/3 | Nhà có 1 phòng trống tầng 3 quận 1 cho thuê 6tr/tháng, phù hợp nữ, giờ giấc tự do, ib mình 0909.000.210 | Chủ nhà cho thuê phòng trống trong nhà mình ("Nhà có 1 phòng trống"), không có dấu hiệu môi giới. |
| `hb-045` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"Gò Vấp","ward":null}` | 3/3 | Mình là chủ nhà, tìm khách thuê phòng trọ Gò Vấp 3tr, vào ở ngay 0909.000.802 | Tự xưng chủ nhà ("Mình là chủ nhà") đang tìm khách thuê phòng trọ tại TP.HCM; không có dấu hiệu môi giới. |
| `hb-040` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 2/3 | Dịch vụ dọn dẹp, vệ sinh căn hộ cho thuê giữa hai khách thuê, giá 150k/giờ khu Cầu Giấy, Thanh Xuân 0909.000.603 | Quảng cáo dịch vụ dọn dẹp, không phải tin cho thuê nhà. |

### `claude__sonnet` × `gia-su-phu-huynh` — 4 lỗi khác nhau

Theo loại: trích sai trường 4.

| Bài | Loại | Trường | Kỳ vọng | AI trả về | Lặp | Văn bản (rút gọn) | Lý do AI nêu |
|---|---|---|---|---|---:|---|---|
| `hg-003` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"TP.HCM","raw":"quan 7","ward":null}` | 3/3 | can tim gia su ly 11 on thi hsg, hoc tai nha quan 7, sdt 0909.000.113 | Tìm gia sư vật lý lớp 11 ôn thi học sinh giỏi, học tại nhà ở quận 7. |
| `hg-008` | trích sai trường | location | `{"district":"Tân Bình","province":"TP. Hồ Chí Minh"}` | `{"district":"Tân Bình","province":"TP.HCM","raw":"khu Tân Bình","ward":null}` | 3/3 | Nhờ mọi người giới thiệu giúp trung tâm hoặc gia sư kèm toán lớp 7 cho con, khu Tân Bình, ưu tiên dạy 1-1, 0909.000.118 | Phụ huynh tìm người kèm toán cho con lớp 7 ở Tân Bình; chấp nhận cả trung tâm lẫn gia sư. |
| `hg-010` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"quận Gò Vấp","ward":null}` | 3/3 | Con mình lớp 5 yếu toán, tìm sinh viên sư phạm dạy kèm cuối tuần quận Gò Vấp, học phí thoả thuận | Phụ huynh tìm người kèm toán lớp 5 tại Gò Vấp, học phí thoả thuận. |
| `hg-013` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"khu Gò Vấp","ward":null}` | 3/3 | Cần gia sư tiếng Anh lớp 8 học tại nhà khu Gò Vấp, bé mất gốc, 250k/buổi, zalo 0909.000.124 | Tìm gia sư tiếng Anh lớp 8 học tại nhà ở TP.HCM. |

### `codex__gpt-6.2-sol__b10` × `bds-tim-nguoi-thue` — 25 lỗi khác nhau

Theo loại: trích sai trường 10; bỏ sót bài khớp 3; gán nhầm là người cùng nghề 12.

| Bài | Loại | Trường | Kỳ vọng | AI trả về | Lặp | Văn bản (rút gọn) | Lý do AI nêu |
|---|---|---|---|---|---:|---|---|
| `hb-002` | trích sai trường | location | `{"district":"Bình Thạnh","province":"TP. Hồ Chí Minh"}` | `{"district":"Bình Thạnh","province":"TP.HCM","raw":"q binh thanh","ward":null}` | 3/3 | can thue phong tro khep kin q binh thanh gan hutech gia 3tr-4tr5 sdt o909 000 102 | Người đăng tìm phòng trọ khép kín gần HUTECH ở Bình Thạnh và nêu mức giá chấp nhận. |
| `hb-003` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"TP.HCM","raw":"Quận 7","ward":null}` | 3/3 | Cần thuê chung cư 2pn Quận 7 13tr 0909000103 | Người đăng nói rõ cần thuê chung cư 2 phòng ngủ tại Quận 7, kèm ngân sách và số liên hệ. |
| `hb-006` | bỏ sót bài khớp | — | `true` | `false` | 3/3 | Cần thuê căn hộ 1pn gần trường ĐH, giá tầm 8tr, nhắn mình qua Zalo 0909.000.106 | Người đăng cần thuê căn hộ 1 phòng ngủ, nhưng chỉ nói gần trường ĐH nên chưa xác định được thành phố mục tiêu. |
| `hb-007` | trích sai trường | location | `{"district":"Tân Bình","province":"TP. Hồ Chí Minh"}` | `{"district":"Tân Bình","province":"TP.HCM","raw":"Tân Bình","ward":null}` | 3/3 | 🙏🙏 Vợ chồng mới cưới e cần thuê chung cư 1pn khu Tân Bình tc 8 củ/tháng ạ, ai có nhắn e zalo 0909.000.107 🏠💕 | Người đăng nói rõ hai vợ chồng mới cưới cần thuê chung cư 1 phòng ngủ tại Tân Bình để ở. |
| `hb-008` | trích sai trường | location | `{"district":"Quận 7","province":"TP. Hồ Chí Minh"}` | `{"district":"Quận 7","province":"TP.HCM","raw":"District 7 HCMC","ward":null}` | 3/3 | Hi all, I'm looking to rent a studio in District 7 HCMC, budget 10-12tr per month, pls PM or call 0909.000.108 | The author is personally looking to rent a studio in District 7, HCMC, and gives a monthly budget. |
| `hb-009` | trích sai trường | location | `null` | `{"district":"Hai Bà Trưng","province":"Hà Nội","raw":"gần ĐH Bách Khoa","ward":null}` | 3/3 | Cần thuê phòng trọ gần ĐH Bách Khoa, sinh viên nữ, giá 2tr5-3tr, ưu tiên khép kín. Zalo 0909.000.109 | Nữ sinh cần thuê phòng gần ĐH Bách Khoa. Thành phố suy từ nhóm thuê nhà Hà Nội, quận suy từ vị trí trường. |
| `hb-010` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"Gò Vấp","ward":null}` | 3/3 | Gia đình 4 người cần thuê nhà nguyên căn 2 tầng khu Gò Vấp, 4 phòng ngủ, 14-16tr/tháng, thuê dài hạn 2 năm. 0909.000.110 | Gia đình 4 người cần thuê nhà nguyên căn tại Gò Vấp để ở trong 2 năm, có yêu cầu rõ về số phòng và ngân sách. |
| `hb-012` | trích sai trường | bedrooms | `null` | `1` | 3/3 | Mình là nhân viên văn phòng, cần thuê studio hoặc căn 1pn khu Hai Bà Trưng, tầm 7-9tr/th, có thang máy. Zalo 0909.000.112 | Nhân viên văn phòng tự tìm chỗ ở tại Hai Bà Trưng. Bài chấp nhận studio hoặc căn hộ 1 phòng ngủ. |
| `hb-013` | trích sai trường | location | `{"district":"Thủ Đức","province":"TP. Hồ Chí Minh"}` | `{"district":"Thủ Đức","province":"TP.HCM","raw":"Thủ Đức","ward":null}` | 3/3 | Em cần thuê căn hộ 3pn Thủ Đức cho gia đình có con nhỏ, 15-18tr, gần trường học. 0909.000.113 | Tìm thuê căn hộ ở Thủ Đức cho gia đình có con nhỏ và cần gần trường học. |
| `hb-038` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 3/3 | Công ty quản lý vận hành căn hộ dịch vụ nhận ký gửi và quản lý căn hộ cho chủ nhà tại Hà Nội, cam kết lấp đầy 95%, hợp tác lâu dài. Liên hệ 0909.000.… | Công ty chào dịch vụ ký gửi và quản lý căn hộ cho chủ nhà, kèm cam kết lấp đầy 95%. |
| `hb-039` | gán nhầm là người cùng nghề | — | `unknown` | `peer` | 3/3 | Nhận quản lý toàn diện nhà cho thuê (thu tiền, sửa chữa, tìm khách) tại TP.HCM, phí 8% doanh thu, ai có nhà trống liên hệ 0909.000.602 | Tác giả chào dịch vụ quản lý, thu tiền và tìm khách cho chủ nhà. Mức 8% doanh thu là phí dịch vụ. |
| `hb-046` | trích sai trường | location | `{"district":"Gò Vấp","province":"TP. Hồ Chí Minh"}` | `{"district":"Gò Vấp","province":"TP.HCM","raw":"Gò Vấp","ward":null}` | 3/3 | Cần tìm chủ nhà cho thuê phòng trọ khu Gò Vấp, giá khoảng 2tr5-3tr, ưu tiên không chung chủ. Zalo 0909.000.803 | Tác giả tìm chủ nhà để thuê phòng trọ tại Gò Vấp, nêu ngân sách và ưu tiên phòng không chung chủ. |

## 7. Nguyên nhân các lỗi trường bắt buộc

Phân loại mọi lỗi `field_mismatch` của trường bắt buộc (gộp mọi lượt). Cột "nếu bỏ qua lỗi tên/thiếu tỉnh" chỉ để chẩn đoán: số chính thức vẫn là so khớp chuỗi sau chuẩn hoá chữ thường như quy định ở [docs/eval/README.md §2](../../README.md); **không** dùng để tuyên bố đạt.

| Cấu hình | Radar | Trường | Đúng gộp | Nguyên nhân (số lần) | Nếu bỏ qua lỗi tên/thiếu tỉnh |
|---|---|---|---:|---|---:|
| `claude__haiku` | `bds-tim-nguoi-thue` | location | 18/42 = 42,86% | chỉ khác cách viết tên tỉnh/thành (vd "TP. Hồ Chí Minh" ↔ "TP.HCM"): 19; AI điền giá trị trong khi nhãn là null (suy diễn thêm): 3; sai quận/huyện: 1; AI chỉ trả quận/huyện, bỏ trống tỉnh/thành (nhãn có tỉnh/thành suy ra từ quận): 1 | 38/42 = 90,48% |
| `claude__haiku` | `bds-tim-chu-nha` | location | 14/42 = 33,33% | chỉ khác cách viết tên tỉnh/thành (vd "TP. Hồ Chí Minh" ↔ "TP.HCM"): 14; AI chỉ trả quận/huyện, bỏ trống tỉnh/thành (nhãn có tỉnh/thành suy ra từ quận): 13; sai tỉnh/thành: 1 | 41/42 = 97,62% |
| `claude__sonnet` | `bds-tim-nguoi-thue` | location | 19/42 = 45,24% | chỉ khác cách viết tên tỉnh/thành (vd "TP. Hồ Chí Minh" ↔ "TP.HCM"): 20; AI điền giá trị trong khi nhãn là null (suy diễn thêm): 3 | 39/42 = 92,86% |
| `claude__sonnet` | `bds-tim-chu-nha` | location | 21/42 = 50,00% | chỉ khác cách viết tên tỉnh/thành (vd "TP. Hồ Chí Minh" ↔ "TP.HCM"): 21 | 42/42 = 100,00% |
| `codex__gpt-6.2-sol__b10` | `bds-tim-nguoi-thue` | location | 17/42 = 40,48% | chỉ khác cách viết tên tỉnh/thành (vd "TP. Hồ Chí Minh" ↔ "TP.HCM"): 21; AI điền giá trị trong khi nhãn là null (suy diễn thêm): 4 | 38/42 = 90,48% |

## 8. Kết luận và việc khắc phục

**Không tuyên bố các cấu hình × Radar sau là được hỗ trợ.** Mỗi dòng cần một việc khắc phục được mở và xử lý trước khi tuyên bố (nội dung sẵn ở [REMEDIATION.md](./REMEDIATION.md)). `agy` chưa đo được (mục 9). Một cấu hình đạt mọi cổng đã đo vẫn chưa được tuyên bố là hỗ trợ vì cảnh báo nhãn nháp ở đầu báo cáo.

| Cấu hình | Radar | Cổng của issue hụt | Cổng H2 khác hụt | Ổn định | Ghi chú |
|---|---|---|---|---|---|
| `claude__haiku` | `bds-tim-nguoi-thue` | field:location | — | ĐẠT |  |
| `claude__haiku` | `bds-tim-chu-nha` | field:location | — | ĐẠT |  |
| `claude__haiku` | `gia-su-phu-huynh` | — | field:location | ĐẠT |  |
| `claude__sonnet` | `bds-tim-nguoi-thue` | field:location | peer_precision | ĐẠT |  |
| `claude__sonnet` | `bds-tim-chu-nha` | field:location | — | ĐẠT |  |
| `claude__sonnet` | `gia-su-phu-huynh` | — | field:location | ĐẠT |  |
| `codex__gpt-6.2-sol__b10` | `bds-tim-nguoi-thue` | match_recall, field:location | peer_precision | CHƯA ĐẠT (3,64%) |  |
| `codex__gpt-6.2-sol__b10` | `bds-tim-chu-nha` | — | — | — | **chưa đo** (xem mục 9) |
| `codex__gpt-6.2-sol__b10` | `gia-su-phu-huynh` | — | — | — | **chưa đo** (xem mục 9) |

## 9. Ghi chú vận hành và cấu hình không đo được

### 9.1. Cấu hình **không** đo được hoặc đo dở

| Cấu hình | Trạng thái | Bằng chứng |
|---|---|---|
| `agy` (Antigravity CLI 1.5.18) | **Không đo được.** Adapter hiện tại gọi `agy --print --output-format json …` và đưa prompt qua stdin. Ở 1.5.18, `--print` bắt buộc nhận **giá trị** (chính prompt); không đọc stdin. Lần gọi đầu thoát mã 2 với thông báo "`--print` took `--output-format` as its prompt"; thử `--print` đứng cuối cho "flag needs an argument", thử `--print=` cho "empty prompt". | Chạy tay trên máy đo, ngày 2026-11-27; xem R2 trong [REMEDIATION.md](./REMEDIATION.md). |
| `codex` `gpt-6.2-sol`, lô 20 | **Không chạy được ở lô 20.** Cả ba Radar thoát với "Lời gọi AI quá thời gian chờ" ở lượt 1 (ngưỡng cứng 120 giây mỗi lời gọi, `DEFAULT_JUDGE_EXTRACT_TIMEOUT`). Nhật ký lần chạy này không được lưu lại (chỉ quan sát trên terminal); số liệu codex trong báo cáo vì vậy dùng **lô 10**. | Quan sát trực tiếp; xem R3. |
| `codex` `gpt-6.2-sol`, lô 10 | **Mới đo xong 1/3 Radar.** `bds-tim-nguoi-thue` đủ 3 lượt. `bds-tim-chu-nha` xong 2 lượt rồi lượt 3 bị chặn: "Đã chạm giới hạn hạn mức AI"; `gia-su-phu-huynh` bị chặn ngay lượt 1. Thử lại bằng lệnh 4 bài vẫn bị chặn. | Nhật ký thô `codex__gpt-6.2-sol__b10/*.log.txt`. Lượt 1 và 2 của `bds-tim-chu-nha` chỉ còn ở dạng văn bản trong nhật ký (bản chạy trước khi harness biết ghi báo cáo dở): recall khớp 12/14 = 85,71% cả hai lượt, precision 12/12. |

Việc cần làm khi hạn mức codex được đặt lại: `node scripts/eval-study.mjs run --provider codex --model gpt-6.2-sol --batch-size 10 --repeat 3 --force`, rồi `node scripts/eval-study.mjs report`.

### 9.2. Giới hạn của số đo

- **Nhãn là bản nháp một người gán** và bài là bản dựng lại, chưa lấy từ nhóm thật ([holdout README §6](../../holdout/README.md)).
- Một số lỗi lặp lại ở mọi cấu hình có thể là **tranh chấp nhãn** chứ không phải lỗi mô hình, và phải do người gán nhãn thứ hai quyết định, không sửa theo đầu ra mô hình ([holdout README §4–5](../../holdout/README.md)): `hb-006` (không nêu thành phố, nhãn là khớp, mô hình đều từ chối), `hb-038`/`hb-039` (công ty quản lý nhà bị cả ba mô hình gọi là `peer` với Radar môi giới cho thuê; nhãn là `unknown`).
- Việc chẩn đoán lỗi `location` ở mục 7 dùng chính các lỗi của holdout-v1. Mọi chỉnh sửa prompt/chuẩn hoá rút ra từ đó phải được đo lại trên **holdout v2 mới**, không phải trên bộ này.
- `claude` không có `--model` mặc định cố định giữa các máy; báo cáo ghi model do CLI trả về (`claude-haiku-5-5`, `claude-sonnet-5-5`). Hai cấu hình `haiku` và `sonnet` được chọn làm đại diện hạng `Fast` và `Smart`.
