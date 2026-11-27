# Tập đánh giá riêng cho Radar do khách tự mô tả (`docs/eval/holdout/`)

Bổ sung cho [bộ vàng 185 mẫu](../README.md) theo [issue #10](https://github.com/TuNa-eTech/deal-sonar/issues/10) (thuộc #1 · Chất lượng trên nhu cầu ngoài mẫu). Bộ vàng cũ chỉ có một Radar cho mỗi ngành, nên chưa trả lời được hai câu hỏi:

1. Khách tự mô tả một nhu cầu **không nằm trong thư viện ngành** thì AI còn giữ được chất lượng không?
2. Cùng **một bài đăng**, với hai khách có mục tiêu khác nhau, AI có cho ra nhãn khớp, vai trò và giá trị trường khác nhau đúng như vậy không?

> [!IMPORTANT]
> **Trạng thái nhãn: bản nháp một người gán (`draft_single_annotator`).** Bài đăng là văn bản dựng lại theo văn phong nhóm thật, **chưa lấy từ nhóm thật**, và **chưa có người gán nhãn độc lập thứ hai**. Mục 6 liệt kê bằng chứng còn thiếu. Không dùng bộ này để tuyên bố đạt H2 trên Radar ngoài mẫu cho tới khi mục 6 hoàn tất.

---

## 1. Các brief được chọn

| Radar (`radar_version_id`) | Khách của Radar | `want_intent` | Loại | Vì sao chọn |
|---|---|---|---|---|
| [`bds-tim-nguoi-thue`](./bds-tim-nguoi-thue.radar.json) | Môi giới cho thuê tìm người đang cần thuê nhà ở | `demand` | trong thư viện | Trường: loại hình, khu vực, ngân sách, số phòng ngủ, SĐT |
| [`bds-tim-chu-nha`](./bds-tim-chu-nha.radar.json) | Đơn vị quản lý nhà tìm chủ nhà chính chủ cho thuê | `supply` | trong thư viện | **Trái chiều** với Radar trên, **cùng nguồn bài**; thêm trường `furnished` (boolean), bỏ qua người cùng nghề là môi giới và công ty quản lý |
| [`gia-su-phu-huynh`](./gia-su-phu-huynh.radar.json) | Gia sư tìm phụ huynh cần dạy kèm | `demand` | **ngoài thư viện** | Ngành, bộ trường (`subject`, `grade`, `mode`, `budget` theo buổi) và kiểu người cùng nghề (gia sư, trung tâm) đều không có trong thư viện mẫu |

Hai Radar BĐS dùng **cùng 55 bài** (cùng `id`, `post_key`, `text`, `created_at_ms`); chỉ nhãn khác nhau. `verify-holdout` kiểm tra điều này tự động. Trong 55 bài có **28 bài đổi nhãn khớp** giữa hai Radar, ví dụ:

| Bài (rút gọn) | `bds-tim-nguoi-thue` | `bds-tim-chu-nha` |
|---|---|---|
| "Cần thuê căn hộ 2pn … Cầu Giấy 11-13tr/th" | khớp, `end_user` | không khớp, `end_user` |
| "Chính chủ cho thuê căn hộ 2pn … Cầu Giấy 13tr/tháng" | không khớp, `end_user` | khớp, `end_user` |
| "Nhà mình cần **tìm người thuê** căn hộ 2pn Thanh Xuân" | không khớp (người cho thuê) | khớp |
| "Cần **tìm chủ nhà** cho thuê phòng trọ Gò Vấp" | khớp (người cần thuê) | không khớp |
| "Công ty quản lý vận hành … nhận ký gửi căn hộ cho chủ nhà" | không khớp, `unknown` | không khớp, **`peer`** |

Vai trò `peer` phụ thuộc vào khách của Radar: công ty quản lý nhà là người cùng nghề với Radar `bds-tim-chu-nha` nhưng không phải với `bds-tim-nguoi-thue`.

## 2. Số mẫu theo Radar

Bảng sinh bằng `node scripts/verify-holdout.mjs --summary` và được đối chiếu với [`manifest.json`](./manifest.json) mỗi lần chạy kiểm tra.

| Radar | Tổng | Dương (khớp) | Âm | Trong đó `peer` | `end_user` | `unknown` | Không chấm vai trò |
|---|---:|---:|---:|---:|---:|---:|---:|
| `bds-tim-nguoi-thue` | 55 | 14 | 41 | 12 | 31 | 11 | 1 |
| `bds-tim-chu-nha` | 55 | 14 | 41 | 14 | 31 | 9 | 1 |
| `gia-su-phu-huynh` | 41 | 13 | 28 | 9 | 22 | 9 | 1 |
| **Cộng** | **151 cặp bài–Radar** (96 bài khác nhau) | **41** | **110** | **35** | **84** | **29** | **3** |

- Tỉ lệ dương 25,5% / 25,5% / 31,7%. Thấp hơn mục tiêu ~30% của [validation plan §3.1](../../delivery/02-validation-plan.md) ở hai Radar BĐS vì nhiều bài âm là bài dễ nhầm có chủ đích.
- "Không chấm vai trò" là bài tiêm lệnh/spam: `expected_author_role = null`, bộ chấm bỏ qua vai trò (quy ước C10).
- Mọi bài khớp gán nhãn **đủ mọi trường** của Radar; trường bài không nêu có nhãn `null` để phạt việc AI tự suy diễn (C5).

## 3. Các ca khó (thẻ `tags`)

| Thẻ | Ý nghĩa | Ví dụ |
|---|---|---|
| `missing_data` | Bài khớp nhưng thiếu trường (không giá, không SĐT, chỉ có địa danh) → nhãn `null` | `hb-004`, `hb-006`, `hg-004` |
| `exception` | Ngoại lệ so với quy tắc chung: pass hợp đồng, ở ghép, thuê mặt bằng, nhạc cụ, mầm non, đại học, nhờ làm hộ bài, hai môn trong một bài | `hb-043`, `hg-023` |
| `confusable` | Đủ từ khoá của Radar nhưng sai ý: "cần tìm người thuê", công ty quản lý, tin tuyển gia sư, "đã tìm được gia sư rồi" | `hb-044`, `hg-021` |
| `bait` | Câu mồi mở bằng nhu cầu rồi chào nguồn/dịch vụ | `hb-032`, `hg-016` |
| `injection` | Chỉ thị giả mạo trong bài | `hb-051`, `hg-032` |
| `no_diacritics`, `abbrev`, `emoji`, `english`, `short`, `long` | Nhiễu hình thức | — |
| `cross_radar_flip` | Tự động: nhãn khớp khác nhau giữa hai Radar chung nguồn | 28 bài |

## 4. Tách riêng khỏi dữ liệu huấn chỉnh

Đây là tập **holdout**: chỉ để đo, không để chỉnh.

- Cấm đưa nguyên văn bài ở đây vào `docs/eval/golden/`, `feedback_examples` của Radar, ví dụ trong prompt, bộ luật hạt giống (`crates/rules`), hay fixture kiểm thử. `verify-holdout` quét nguyên văn mọi tệp được git theo dõi (ngoài thư mục này và `docs/eval/reports/`, nơi chỉ chứa kết quả đo có trích ví dụ lỗi) và **lỗi** nếu thấy.
- Id dùng tiền tố `hb-` / `hg-`, không trùng `bds-` / `dv-` / `xe-` / `ml-` của bộ vàng.
- Khi một thay đổi prompt/rules được tinh chỉnh dựa trên lỗi của holdout, kết quả holdout sau đó **không còn là số liệu độc lập** → phải thay bằng holdout v2 mới. Ghi vào PR khi xảy ra.
- Nhãn đã đóng băng ở `holdout-v1`. Sửa nhãn sau khi đã chạy mô hình chỉ được phép khi có dòng trong [`annotation/agreement-log.jsonl`](./annotation/agreement-log.jsonl) với lý do "lỗi nhãn chứng minh được từ văn bản bài", và không dựa trên đầu ra của mô hình.

## 5. Quy ước gán nhãn và xử lý nhãn bất đồng

### 5.1. Bộ quy ước (nguồn chân lý khi hai người gán nhãn khác nhau)

| Mã | Quy ước |
|---|---|
| C1 | `peer` được xét theo **nghề của khách Radar**, không theo nghề chung chung. Môi giới có khách, sale tìm khách, công ty quản lý (với Radar tìm chủ nhà), gia sư/trung tâm (với Radar gia sư) đều là `peer`. Dịch vụ liên quan nhưng khác nghề (dọn dẹp) là `unknown`. |
| C2 | Người thuê pass/nhượng hợp đồng không phải chính chủ: không khớp cả hai Radar BĐS, `unknown`. |
| C3 | Tìm người ở ghép: người đã có chỗ, không phải khách thuê mới: không khớp, `unknown`. |
| C4 | Chiều của bài do **vai trò hành động của tác giả** quyết định, không do động từ trong câu: "cần tìm người thuê" là phía cho thuê; "cần tìm chủ nhà" là phía cần thuê. |
| C5 | Trường không có trong bài → `null`. **Không suy luận** từ địa danh/trường học (vd "gần ĐH Bách Khoa" → `location = null`); chỉ nêu thành phố → chỉ `province`. Bài vẫn khớp nếu ý định đúng. |
| C6 | Tin có từ 3 căn/phòng trở lên, "giỏ hàng", hoa hồng, ctv, ký gửi, phí môi giới → `peer`. |
| C7 | Câu mồi: mở bằng nhu cầu rồi chuyển sang chào nguồn/dịch vụ → `peer`, không khớp. |
| C9 | "Thoả thuận", "thương lượng", "liên hệ" không phải giá → `price/budget = null`. |
| C10 | Spam và bài tiêm lệnh: không khớp, `expected_author_role = null` (không chấm vai trò). |
| C11 | Tin cho thuê đơn lẻ không có dấu hiệu môi giới → `end_user` (gánh nặng chứng minh thuộc về `peer`). Người nhà chủ nhà → `end_user`. |
| C12 | Nhiều lựa chọn loại hình/môn học ("studio hoặc 1pn") → lấy lựa chọn nêu **đầu tiên**. |
| C13 | Nhiều quận được nêu → bỏ `district`, giữ `province`. |
| C14 | Ngoài phạm vi Radar (mua bán, thuê mặt bằng, sang nhượng): không khớp; `end_user` nếu cá nhân, `unknown` nếu không rõ. |
| C15 | Nhờ giới thiệu "trung tâm hoặc gia sư" cho nhu cầu học kèm của con → **khớp**. |
| C16 | IELTS/TOEIC → môn `tiếng Anh`. |
| C17 | Hai môn trong một bài → môn nêu đầu tiên (xem C12). |
| C18 | Tin tuyển gia sư của trung tâm → `peer`, không khớp. |
| C19 | Ngoài chương trình phổ thông (mầm non, nhạc cụ, thể thao, đại học) hoặc nhu cầu khác của phụ huynh (trông trẻ, thuê trọ) → không khớp, `end_user`. |
| C20 | Không có nhu cầu đang mở (hỏi kinh nghiệm, đã tìm được, học nhóm tự học) → không khớp, `end_user`. |
| C21 | Nhờ làm hộ bài (vi phạm học thuật) → không khớp, `unknown`. |

Mỗi mẫu ghi mã áp dụng ở trường `conventions`.

### 5.2. Hai người gán nhãn độc lập

- Chọn trước `second_pass = true` cho **≥ 20% số bài của mỗi Radar** (hiện 17/55, 17/55, 10/41), đủ cả dương lẫn âm và ưu tiên bài `confusable`/`exception`/`missing_data`.
- Người thứ hai nhận **phiếu mù** từ `node scripts/verify-holdout.mjs --emit-blind-sheet` (chỉ có mô tả Radar và văn bản bài, không có nhãn, không có quy ước của người thứ nhất ngoài §5.1), trả về [`annotation/annotator-b.jsonl`](./annotation/) với `{radar, id, expected_match, expected_author_role, expected_fields}`.
- Đo: Cohen's κ cho nhãn khớp (đích ≥ 0,8 cho mỗi Radar), tỉ lệ trùng vai trò và trùng giá trị trường (so sánh sau chuẩn hoá).

### 5.3. Quy tắc xử lý bất đồng (áp dụng theo thứ tự)

1. **Tra quy ước §5.1.** Nếu một quy ước quyết định được → theo quy ước; ghi dòng vào `agreement-log.jsonl` với `resolution = "convention"`.
2. **Không có quy ước phù hợp** → người phân xử thứ ba (chủ sản phẩm, không phải một trong hai người gán nhãn) quyết định **mà không xem đầu ra của mô hình**. Thêm quy ước mới `C22…`, rồi **rà lại mọi mẫu cùng loại** (không chỉ mẫu bất đồng). Ghi `resolution = "adjudicator"`.
3. **Cả hai đáp án đều bảo vệ được** (văn bản bài thật sự mơ hồ) → loại mẫu khỏi chấm điểm (`resolution = "dropped"`, giữ trong nhật ký). Tối đa 5% mỗi Radar; vượt mức đó là dấu hiệu quy ước còn thiếu, quay lại bước 2.
4. Mẫu đã giải quyết đổi `label_status` thành `double_annotated_adjudicated`. Đặt κ < 0,8 hoặc có bất đồng chưa ghi nhật ký thì `--release` thất bại.
5. Không có "bỏ phiếu theo mô hình": đầu ra mô hình **không bao giờ** là căn cứ đổi nhãn.

## 6. Ẩn danh và bằng chứng còn thiếu

**Đã làm trong repo**

- Tên tác giả là bí danh `ab-001` hoặc `null`; tên nhóm bắt đầu bằng "Nhóm mẫu:"; mọi số điện thoại thuộc dải giả `09xx.000.xxx` (mọi biến thể viết: `o909 000 102`, `0909000103`, `+84…`).
- `verify-holdout` từ chối URL, email, liên kết tài khoản, dãy 12 số, số điện thoại ngoài dải giả.

**Chưa làm — cần chủ sở hữu**

| Hạng mục | Cần | Ai |
|---|---|---|
| Lấy mẫu từ nhóm thật | Người là thành viên nhóm xuất bài, **xoá tên/SĐT/liên kết thật, thay giá trị giả cùng định dạng** rồi thay các bài dựng lại; giữ nguyên `id` | Chủ sản phẩm / người gán nhãn |
| Người gán nhãn thứ hai | Nhận phiếu mù, trả `annotation/annotator-b.jsonl`, ghi nhật ký bất đồng, chạy `node scripts/verify-holdout.mjs --release` | Người gán nhãn độc lập (không phải người soạn bộ này) |
| Chạy CLI thật | `claude`/`codex`/`agy` ở tầng `fast` và `smart`, lô 5/10/20/40, 3 lượt để đo độ ổn định (§3.2 validation plan) | Máy có đăng nhập CLI |
| Quyết định ngưỡng | So kết quả ba Radar với ngưỡng H2; Radar `gia-su-phu-huynh` là mốc cho "ngoài mẫu" | Chủ sản phẩm |

## 7. Cách chạy

```bash
# Kiểm tra cấu trúc, ẩn danh, đếm mẫu, tách khỏi repo (không cần mạng)
pnpm eval:holdout:verify

# Đường cơ sở ngoại tuyến (mock) cho cả ba Radar
pnpm eval:holdout

# Một Radar với nhà cung cấp thật
cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/holdout/gia-su-phu-huynh.jsonl \
  --radar docs/eval/holdout/gia-su-phu-huynh.radar.json \
  --provider claude --tier smart --batch-size 20 --json

# Phiếu mù cho người gán nhãn thứ hai / kiểm tra phát hành
node scripts/verify-holdout.mjs --emit-blind-sheet > blind-sheet.jsonl
node scripts/verify-holdout.mjs --release
```

Các tệp `.jsonl` tương thích trình chạy `eval` hiện có: dòng `#` bị bỏ qua và các khoá bổ sung (`post_key`, `tags`, `conventions`, `second_pass`, `label_status`) bị bộ đọc bỏ qua.

### Kết quả ngoại tuyến hiện có (mock, lô 20) — không phải kết quả nghiệm thu

Bộ giả lập `mock` là heuristic viết cho BĐS/dịch vụ/xe, không phải oracle; trên holdout nó **không đạt** ngưỡng H2, và đây đúng là điều holdout cần cho thấy (mock không có kiến thức về gia sư và không phân biệt được hai chiều của hai Radar trái chiều).

| Radar | Precision khớp | Recall khớp | Peer P / R | Trường bắt buộc kém nhất |
|---|---:|---:|---:|---|
| `bds-tim-nguoi-thue` | 73,33% | 78,57% | 87,50% / 58,33% | `property_type` 78,57% |
| `bds-tim-chu-nha` | 52,94% | 64,29% | 100% / 57,14% | `property_type` 71,43% |
| `gia-su-phu-huynh` | 0,00% | 0,00% | 100% / 11,11% | `subject` 53,85% |

Tỉ lệ bịa `raw` của mock bằng 0% trên cả ba Radar. Chưa có kết quả từ nhà cung cấp CLI thật (mục 6).
