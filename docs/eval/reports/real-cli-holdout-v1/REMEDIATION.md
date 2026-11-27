# Việc khắc phục cần mở từ kết quả #11

Theo tiêu chí nghiệm thu của [#11](https://github.com/TuNa-eTech/deal-sonar/issues/11), nhu cầu hụt ngưỡng chưa được tuyên bố là được hỗ trợ cho tới khi việc khắc phục tương ứng xong. Đây là nội dung sẵn để mở issue; **chưa có issue nào được tạo trên GitHub** (cần người có quyền mở). Số liệu lấy từ [REPORT.md](./REPORT.md).

| Mã | Tiêu đề đề xuất | Ảnh hưởng | Trạng thái |
|---|---|---|---|
| R1 | AI trả tên tỉnh/thành không thống nhất và không chuẩn hoá được → trường bắt buộc `location` hụt ngưỡng | Cả hai Radar BĐS, mọi cấu hình đã đo (claude haiku/sonnet, codex) | Mở |
| R2 | Adapter `agy` không tương thích `agy` 1.5.18 (prompt phải là giá trị của `--print`) | Không đo được `agy`; không thể tuyên bố hỗ trợ | Mở |
| R3 | Lời gọi vượt 120 giây làm hỏng cả lượt chấm thay vì chia đôi lô; cần cỡ lô mặc định theo provider | codex ở lô 20 (3/3 Radar), claude haiku sát ngưỡng (~80–90 giây/lô 20) | Mở |
| R4 | `codex` gpt-6.2-sol chưa đạt recall khớp và ổn định trên Radar `bds-tim-nguoi-thue`; chưa đo đủ 2 Radar còn lại do hết hạn mức | codex | Mở, cần chạy lại sau khi hạn mức đặt lại |
| R5 | Tranh chấp nhãn `peer`/khớp ở `hb-006`, `hb-038`, `hb-039` | Phép đo peer precision và recall khớp của `bds-tim-nguoi-thue` | Chuyển cho người gán nhãn thứ hai ([#10](https://github.com/TuNa-eTech/deal-sonar/issues/10)) |
| R6 | Codex adapter truyền `-c mcp_servers.dealsonar.enabled=false` cùng `--ignore-user-config` | Mọi lời gọi `codex` thất bại ("invalid transport") với codex 0.172.0 | **Đã sửa** ở nhánh này (`crates/ai-bridge/src/adapters/codex.rs`) |

---

## R1 — Chuẩn hoá tỉnh/thành trong trường `location`

**Số liệu** (trường bắt buộc `location`, ngưỡng ≥ 90%, đúng gộp 3 lượt):

| Cấu hình | `bds-tim-nguoi-thue` | `bds-tim-chu-nha` |
|---|---|---|
| claude haiku | 18/42 = 42,86% | 14/42 = 33,33% |
| claude sonnet | 19/42 = 45,24% | 21/42 = 50,00% |
| codex gpt-6.2-sol (lô 10) | 17/42 = 40,48% | chưa đo đủ |

**Nguyên nhân quan sát được** (phân loại trong REPORT mục 7): hầu hết lỗi không phải sai địa danh mà là (a) tên tỉnh/thành khác dạng nhãn — `TP.HCM`, `Hồ Chí Minh` thay vì `TP. Hồ Chí Minh`; (b) AI chỉ trả quận/huyện và để `province = null` ở một số lượt (claude haiku `bds-tim-chu-nha` lượt 3: 14/14 bài); (c) AI suy ra tỉnh/thành từ tên nhóm khi bài không nêu (`hb-009`). Nếu bỏ qua (a) và (b), độ đúng `location` là 90,48–100%, nghĩa là **vấn đề nằm ở chuẩn hoá chứ không ở nhận diện địa danh**. Con số này chỉ để chẩn đoán, không dùng để tuyên bố đạt.

Pipeline hiện chưa chuẩn hoá đầu ra AI: bộ gazetteer `vn_admin` trong `crates/rules/src/extractors/gazetteer/data.rs` đã có tên chuẩn và bí danh (`tp.hcm`, `hcm`, `sai gon`, …) nhưng chỉ dùng cho trích xuất từ văn bản, không dùng để chuẩn hoá `location` do AI trả về. Prompt/schema (`crates/ai-bridge/src/prompts.rs`, dòng mô tả `location`) không nêu tên chuẩn.

**Hướng xử lý đề xuất** (chọn một, cân nhắc đánh đổi):
1. Chuẩn hoá sau AI qua gazetteer: ánh xạ `province`/`district` về tên chuẩn và suy tỉnh/thành từ quận/huyện. Giữ nguyên prompt; kết quả tất định.
2. Ép enum tỉnh/thành trong schema và nêu tên chuẩn trong prompt.
3. Quyết định chính sách: tỉnh/thành suy từ quận có được tính là "đúng" khi bài không nêu không (hiện nhãn holdout-v1 có suy ra; xem convention C5/C13 và REPORT mục 7).

**Chấp nhận khi:** đo lại trên **holdout v2 mới** (không phải holdout-v1, vì holdout-v1 đã dùng để chẩn đoán — [README §4](../../holdout/README.md)); `location` ≥ 90% ở mọi lượt, trên cả hai Radar BĐS, với từng cấu hình dự kiến hỗ trợ.

## R2 — `agy` 1.5.18 không còn đọc prompt từ stdin

`crates/ai-bridge/src/adapters/agy.rs` chạy `agy --print --output-format json --json-schema <file> … ` và ghi prompt vào stdin ([spec 06 §3.1](../../../specs/06-ai-bridge.md): prompt đi qua stdin để tránh lộ trong danh sách tiến trình). Với `agy` 1.5.18 `--print` nhận giá trị là prompt: `--print` đứng trước cờ khác nuốt cờ đó làm prompt (thoát mã 2); đứng cuối báo "flag needs an argument"; `--print=` cho "empty prompt". Hệ quả: bước `probe` và mọi lời gọi thất bại, `agy` không thể đo.

Lựa chọn (cần quyết định có tính bảo mật, nên không tự áp dụng ở đây): (a) truyền prompt qua `--print=<prompt>` kèm giới hạn kích thước và ghi rõ rủi ro lộ qua danh sách tiến trình; (b) dùng `--input-format stream-json --output-format stream-json` với stdin NDJSON và viết bộ đọc phong bì mới; (c) bỏ `agy` khỏi danh sách hỗ trợ MVP. **Chấp nhận khi:** lệnh `node scripts/eval-study.mjs run --provider agy --model <model>` chạy hết 3 Radar × 3 lượt và báo cáo có số liệu.

## R3 — Quá thời gian chờ và cỡ lô

Quan sát: codex gpt-6.2-sol ở lô 20 vượt 120 giây ở cả 3 Radar nên cả lượt đo thất bại; ở lô 10 mỗi lời gọi khoảng 60 giây (18 lời gọi cho 55 bài × 3 lượt trong 18,3 phút). claude haiku ở lô 20 tốn khoảng 80–90 giây mỗi lời gọi. Trong `judge_extract_batch`, chỉ `InvalidOutput`/`Refused` được thử lại rồi chia đôi; `Timeout` nổi lên và huỷ cả `judge_extract_all`.

**Đề xuất:** coi `Timeout` như lỗi cần chia đôi lô (cùng cơ chế `bisect` hiện có); chọn cỡ lô mặc định theo provider từ dữ liệu này (claude ≤ 20, codex ≤ 10) hoặc đặt timeout theo cỡ lô; ghi lại ở validation plan §3.3. **Chấp nhận khi:** một lô chạm timeout được chia đôi thành công và không còn làm hỏng cả lượt chấm.

## R4 — codex: recall khớp và ổn định

`bds-tim-nguoi-thue` (lô 10, 3 lượt): recall khớp gộp 37/42 = 88,10% (lượt 3: 11/14 = 78,57%); ổn định 2/55 = 3,64% > 3% (bài `hb-005`, `hb-009`). `bds-tim-chu-nha`: lượt 1 và 2 cùng đạt 12/14 = 85,71% recall (theo nhật ký thô). `gia-su-phu-huynh` chưa đo. **Chấp nhận khi:** chạy lại trọn 3 Radar × 3 lượt sau khi hạn mức đặt lại và tất cả cổng đạt, hoặc quyết định chỉ dùng `codex` ở hạng `Smart`/không đưa vào danh sách hỗ trợ.

## R5 — Tranh chấp nhãn (không sửa theo đầu ra mô hình)

`hb-006` ("Cần thuê căn hộ 1pn gần trường ĐH, giá tầm 8tr…", không nêu thành phố): nhãn khớp, cả ba mô hình đều từ chối vì Radar giới hạn Hà Nội/TP.HCM. `hb-038`/`hb-039` (công ty quản lý nhà): nhãn `unknown`, cả ba mô hình gọi `peer` với Radar "môi giới cho thuê". Người gán nhãn thứ hai và người phân xử theo [holdout README §5.3](../../holdout/README.md) quyết định, rồi rà lại các mẫu cùng loại. Sau đó chạy lại báo cáo.

## R6 — Đã sửa trong nhánh này

`codex exec` 0.172.0 từ chối cấu hình khi vừa có `--ignore-user-config` vừa có `-c mcp_servers.dealsonar.enabled=false` (`Error loading config.toml: invalid transport in mcp_servers.dealsonar`), vì ghi đè tạo ra một mục MCP không có transport. Adapter nay chỉ thêm ghi đè đó khi **không** dùng `--ignore-user-config`. Xác nhận bằng lệnh thật: `eval --provider codex --model gpt-6.2-sol` trả kết quả thay vì lỗi cấu hình.
