# Quy trình đo chạy dài ngày: độ trễ, phục hồi và hạn mức AI

Trạng thái: nháp v0.1 · bổ sung cho [Kế hoạch kiểm chứng §4.2](02-validation-plan.md#42-radar-có-làm-cạn-hạn-mức-gói-ai-không)

Tài liệu này nói cách đo ba việc trên máy thật khi nhiều Radar dùng chung nguồn: lượng việc và lượng AI phát sinh, độ trễ từ lúc bài được đăng đến lúc tin tới tay người dùng, và việc hệ thống phục hồi thế nào sau gián đoạn. Công cụ đo, bộ mô phỏng kiểm tra công cụ và các định nghĩa đã có sẵn. **Chưa có số liệu nào từ máy thật**: các mục "Kết quả" dưới đây để trống cho tới khi chạy xong.

## 1. Đã có gì và chưa có gì

| Phần | Trạng thái |
|---|---|
| Công cụ báo cáo `dealsonar-soak-report` (đọc cơ sở dữ liệu, chỉ đọc) | Có, đã kiểm thử trên cơ sở dữ liệu dựng tay với mốc thời gian đã biết |
| Bộ mô phỏng `crates/core/tests/soak_simulation.rs` (3 cấu hình, 3 Radar chung nguồn, AI giả, Telegram giả, 4 loại gián đoạn) | Có, chạy trong `cargo test`; kiểm tra công cụ và hành vi của pipeline, **không phải bằng chứng** cho tiêu chí |
| 7 ngày chạy 3 cấu hình trên máy thật, group thật, gói AI thật | **Chưa làm**: cần chủ sở hữu (§8) |
| Thử máy ngủ, mất phiên Chrome, hết hạn mức AI, lỗi kênh báo trên máy thật | **Chưa làm** |

## 2. Cấu hình cần chạy

Mỗi cấu hình chạy riêng 7 ngày liên tục, cùng một bộ Radar dùng chung toàn bộ group của cấu hình đó. Gợi ý bộ Radar: 3 Radar khác nhau trên cùng nhóm (ví dụ "khách thuê", "khách mua", "chủ nhà cho thuê") để có hàng đợi AI chồng nhau.

| Cấu hình | Group | Mức hoạt động (đề xuất, cần duyệt trước khi đo) |
|---|---|---|
| 5 group vắng | 5 | dưới 5 bài mới mỗi group mỗi ngày |
| 10 group trung bình | 10 | 5–30 bài mới mỗi group mỗi ngày |
| 10 group sôi động | 10 | trên 30 bài mới mỗi group mỗi ngày |

Giữ mặc định của app (tần suất quét, cỡ lô, `daily_ai_post_cap` = 2000, ngưỡng điểm). Không sửa Radar giữa chừng, vì mỗi lần sửa tạo phiên bản mới và làm bộ luật cũ hết hiệu lực. Ghi lại: mô hình máy, hệ điều hành, gói AI và nhà cung cấp, Radar nào có bộ luật từ khi nào.

Theo [Kế hoạch §1](02-validation-plan.md), ngưỡng phải được duyệt **trước** khi đo.

## 3. Ghi gián đoạn

Mỗi gián đoạn được ghi vào `interruptions.json` ngay khi xảy ra (giờ epoch mili giây, lấy bằng `date +%s000`):

```json
[
  { "kind": "machine_sleep",  "start_ms": 1796000000000, "end_ms": 1796003600000, "note": "gập máy 60 phút" },
  { "kind": "chrome_session", "start_ms": 1796100000000, "end_ms": 1796103600000, "note": "đăng xuất Facebook" },
  { "kind": "ai_quota",       "start_ms": 1796200000000, "end_ms": 1796207200000, "note": "tự nhiên / cố ý" },
  { "kind": "channel_error",  "start_ms": 1796300000000, "end_ms": 1796302800000, "note": "chặn api.telegram.org" }
]
```

Mỗi loại thử ít nhất một lần ở cấu hình trung bình và một lần ở cấu hình sôi động. Ghi rõ lần nào do tự nhiên, lần nào do cố ý gây ra.

| Loại | Cách gây ra | Ghi lại |
|---|---|---|
| `machine_sleep` | Ngủ máy 30–60 phút (`pmset sleepnow` hoặc gập máy), sau đó mở lại | Giờ ngủ và giờ thức |
| `chrome_session` | Đăng xuất Facebook trong profile Chrome của tiện ích, 30–60 phút, rồi đăng nhập lại | Giờ đăng xuất, giờ app báo lỗi phiên, giờ đăng nhập lại |
| `ai_quota` | Không thể ép hết hạn mức gói thật mà không tốn gói; ghi các lần hết hạn mức tự nhiên. Nếu cần chủ động: dùng một tài khoản gói rẻ nhất có CLI và đẩy dồn bài vào, hoặc tạm đổi nhà cung cấp sang lệnh luôn trả lỗi hạn mức. Không dùng tài khoản chính | Giờ lỗi đầu tiên, giờ lần gọi thành công đầu tiên |
| `channel_error` | Chặn `api.telegram.org` 20–30 phút (ví dụ dòng `127.0.0.1 api.telegram.org` trong `/etc/hosts`, xoá sau khi thử) hoặc thu hồi token bot rồi cấp lại | Giờ bắt đầu, giờ khôi phục |

Quy ước: `start_ms` là lúc sự cố bắt đầu, `end_ms` là lúc điều kiện được khôi phục. Mọi phép đo "sau phục hồi" tính từ `end_ms`.

## 4. Lấy số liệu

Chạy trên **bản sao** cơ sở dữ liệu (Cài đặt, mục Dữ liệu, sao lưu; hoặc chép `dealsonar.db` cùng `-wal` và `-shm` khi app đã đóng). Trên macOS, thư mục dữ liệu là `~/Library/Application Support/DealSonar/`.

```bash
# một lần, từ thư mục gốc repo
cargo build --release -p dealsonar-store --bin dealsonar-soak-report

target/release/dealsonar-soak-report \
  --db /đường/dẫn/bản-sao/dealsonar.db \
  --label "10 group sôi động" \
  --interruptions interruptions.json \
  --format markdown --out soak-10-soi-dong.md

# bản máy đọc, để lưu cùng báo cáo
target/release/dealsonar-soak-report --db … --label … --interruptions … --format json --out soak-10-soi-dong.json
```

Tuỳ chọn: `--from-ms` / `--until-ms` giới hạn khoảng đo (mặc định từ bài thu đầu tiên đến lúc chạy lệnh), `--slow-minutes` đổi ngưỡng liệt kê tin chậm (mặc định 10), `--rules-active-from-ms` ép mốc "luật hoạt động" cho mọi Radar. Báo cáo chỉ có số liệu và mã định danh: không có nội dung bài, tên tác giả, số điện thoại hay nội dung tin nhắn, nên đính kèm vào hồ sơ được.

Nên chạy báo cáo mỗi ngày (kèm sao lưu) để thấy xu hướng và để còn số liệu nếu dữ liệu bị dọn sau đó.

## 5. Ánh xạ vào tiêu chí

### 5.1 Cấu hình và số liệu cơ bản

Mục 1, 2, 4, 5 của báo cáo cho từng cấu hình: số bài thu (và bài duy nhất, khác nhau khi cùng một bài xuất hiện ở nhiều group), số cặp bài–Radar đã chấm, số cặp cần AI, số lần gọi AI (kèm số bài, token, thời lượng, theo nhà cung cấp và theo tác vụ) và số tin gửi (theo kênh, số lần thử lại, số thất bại).

### 5.2 Gián đoạn và đối soát

Mục 7 của báo cáo, mỗi gián đoạn một khối. Cách đọc:

| Hiện tượng | Dấu hiệu trong báo cáo |
|---|---|
| Bài chậm | Bài đăng trong lúc gián đoạn nhưng thu muộn (`late_capture_lag`); tin trong danh sách "tin chậm nhất" với phần "Đăng → thu" lớn |
| Bài sót | "Có thể bị sót" ở mục 2 (cặp bài–Radar đang hoạt động mà không có lượt chấm), "Lượt chấm còn dở", tin tạo ra mà chưa có thông báo |
| Bài hoặc tin trùng | "Gửi trùng cùng một tin tới một kênh" (lỗi gửi lại sau phục hồi) và "Cùng một bài báo cho nhiều Radar trên một kênh" (xem §7) |
| Tiến độ sau phục hồi | Hàng chờ AI lúc kết thúc và thời gian xử lý hết; thời gian từ `end_ms` đến lần gọi AI thành công đầu tiên; độ trễ gửi sau khi kết thúc của tin tạo trong lúc gián đoạn; thông báo còn chờ |

"Có thể bị sót" chỉ là danh sách cần kiểm tra: hệ thống không lưu lịch sử bật/tắt Radar, nên Radar bật sau khi bài được thu cũng hiện ở đây. Đối chiếu từng mục trong mẫu `possibly_missed_sample` với thời điểm bật Radar trước khi kết luận là sót.

### 5.3 Độ trễ

Mục 6: trung vị của (lúc gửi tin đầu tiên − lúc bài được đăng), tách thành "đăng → thu" (do tiện ích quét) và "thu → gửi" (do app). Đạt khi trung vị < 10 phút. Lúc đăng là `posts.created_at`, nếu không biết thì lấy lúc thu. Chỉ tin thật sự được gửi mới được đo: tin điểm thấp, tin quá hạn và tin chấm bù khi bật lại Radar không có thông báo nên không nằm trong phép đo.

### 5.4 Tỷ lệ bài cần AI sau khi luật hoạt động

Mục 3: bài duy nhất cần AI ÷ bài duy nhất đã thu, tính từ lúc bộ luật của từng Radar hoạt động (`rulesets.activated_at`), chỉ tính các Radar đã có luật. Mục tiêu ≤ 15% (G4). Kèm theo mục 4, bảng "theo Radar" cho biết Radar nào gây ra lượng AI. Tỷ lệ cả khoảng đo (trước khi có luật) nằm ở mục 2 để so sánh.

Một bài được tính là "cần AI" nếu có ít nhất một Radar phải gọi AI cho nó. Vì vậy chỉ cần một Radar chưa có luật là tỷ lệ này tiến tới 100%; muốn đạt mục tiêu thì mọi Radar dùng chung nguồn phải có luật (hoặc phần lớn bài bị loại ở lọc sơ bộ). Báo cáo nêu số Radar chưa có luật để người đọc không hiểu nhầm.

## 6. Định nghĩa

| Số liệu | Định nghĩa |
|---|---|
| Bài thu | Bài có `captured_at` trong khoảng đo |
| Bài duy nhất | Bài không phải bản đăng lại đã gộp vào bài khác (`dup_cluster_id` rỗng hoặc là bài đầu cụm) |
| Cặp bài–Radar | Một dòng `evaluations` không phải xem thử, tạo trong khoảng đo |
| Cặp cần AI | Cặp do AI quyết định, có gắn lần gọi AI, đang chờ AI hoặc lỗi AI |
| Lần gọi AI | Một dòng `ai_calls` trong khoảng đo; lần chạm hạn mức là `status = rate_limited`; gắn với Radar qua `radar_version_id` |
| Tin gửi | Dòng `outbox` có `state = sent`; một tin được tính đã báo nếu có lần gửi thành công hoặc `notified_at` |
| Thử lại | Thông báo có hơn một lần thử hoặc đang chờ sau một lần lỗi |
| Độ trễ | Lần gửi thành công đầu tiên của tin − `COALESCE(posts.created_at, posts.captured_at)` |

## 7. Hành vi đã thấy trong mô phỏng, cần xác nhận trên máy thật

Bộ mô phỏng chạy pipeline thật với AI và Telegram giả, và cho thấy những điểm sau. Đây là hành vi của mã, không phải số đo; cần xem lại khi có số liệu thật.

1. **Phục hồi sau hạn mức AI không tức thì.** Lần gọi AI lỗi hạn mức đặt khoảng chờ (`retry_after` hoặc 60 giây), nhưng việc chấm theo lô được thử lại theo lịch riêng: 1 phút, 5 phút, 15 phút, sau đó dừng và chờ bộ lập lịch xếp việc mới. Hệ quả: các cặp đang chờ vẫn nằm trong hàng đợi dù AI đã trả lời lại. Số đo cần thu: thời gian từ `end_ms` đến lần gọi AI thành công đầu tiên và đến lúc hàng chờ trống.
2. **Cùng một bài báo nhiều lần khi khớp nhiều Radar.** Mỗi Radar tạo tin và thông báo riêng, nên một bài khớp hai Radar chung kênh tạo hai tin nhắn Telegram. Báo cáo đếm riêng số bài này ("nhiều Radar trên một kênh") để chủ sở hữu quyết định có cần gộp hay không. Hành vi hiện tại không bị đổi.
3. **Gửi trùng cùng một tin** (một tin tới một kênh nhiều lần) mong đợi bằng 0 sau khi kênh khôi phục; mô phỏng không thấy trường hợp này.
4. **Thông báo lỗi lần đầu** nằm lại ở hàng đợi với một lần thử và lỗi được ghi; chỉ khi đã gửi thành công thì lỗi được xoá. Vì vậy "thử lại" đếm cả thông báo còn chờ sau một lần lỗi.
5. **Bài chỉ khác chữ số hoặc số điện thoại bị coi là trùng.** Khi viết bộ mô phỏng, các bài cùng khuôn mẫu chỉ khác số (giá, số điện thoại) bị gộp thành một cụm trước khi chấm. Bài đăng lại và bài gần giống được gộp (so khớp chính xác, và gần đúng với bài dài từ 80 ký tự). Với nhóm bài theo khuôn mẫu, "bài duy nhất" có thể thấp hơn nhiều so với "bài thu"; báo cáo luôn nêu cả hai số.
6. Tin tạo ra không phải tin nào cũng có thông báo ngay: tin điểm thấp không báo, và Radar vượt ngưỡng tin mỗi giờ (bộ lọc bão tin) tự chuyển sang gửi gộp. Ở cấu hình sôi động mô phỏng, Radar có luật tạo 40 tin nhưng chỉ gửi 30 tin nhắn riêng lẻ. Mục 5 của báo cáo tách "đã báo / chưa báo" theo Radar để thấy điều này.

## 8. Việc cần chủ sở hữu và bằng chứng còn thiếu

Việc chỉ làm được trên máy thật và không thể thay bằng mô phỏng:

1. Duyệt ngưỡng và mức hoạt động của ba cấu hình (§2) trước khi đo.
2. Chọn group thật (5 vắng, 10 trung bình, 10 sôi động), tạo 3 Radar chung nguồn, bật tiện ích Chrome với tài khoản thử, và cho chạy liên tục 7 ngày mỗi cấu hình.
3. Thực hiện bốn loại gián đoạn (§3), ghi `interruptions.json`.
4. Chạy `dealsonar-soak-report` mỗi ngày và sau khi kết thúc, lưu báo cáo Markdown và JSON.
5. Điền bảng kết quả dưới đây và đối chiếu từng "có thể bị sót" với lịch bật Radar.
6. Báo cáo khi có lần chạm hạn mức AI ở cấu hình trung bình (ngưỡng đạt: 0 lần trong 7 ngày) và khi người dùng thử thấy gói AI bị ảnh hưởng.
7. Quyết định xử lý hai điểm mở ở §7: thời gian phục hồi AI và việc báo nhiều lần cho cùng một bài.

Cho tới khi 1–5 hoàn tất, **không** được ghi rằng tiêu chí về độ trễ (< 10 phút), tỷ lệ AI (≤ 15%) hay phục hồi sau gián đoạn đã đạt.

## 9. Bảng kết quả (chưa có số liệu thật)

| | 5 group vắng | 10 group trung bình | 10 group sôi động |
|---|---|---|---|
| Ngày bắt đầu, ngày kết thúc | | | |
| Bài thu / bài duy nhất | | | |
| Cặp bài–Radar đã chấm | | | |
| Cặp cần AI, bài duy nhất cần AI | | | |
| Lần gọi AI, số bài, token | | | |
| Lần chạm hạn mức AI | | | |
| Tin tạo ra / tin gửi / gửi lại / thất bại | | | |
| Trung vị đăng → gửi (đạt khi < 10 phút) | | | |
| Tỷ lệ bài duy nhất cần AI sau khi có luật (đạt khi ≤ 15%) | | | |
| Lượng AI theo Radar | | | |

| Gián đoạn | Bài chậm | Bài sót | Tin trùng | Hàng chờ xử lý hết sau | Ghi chú |
|---|---|---|---|---|---|
| Máy ngủ | | | | | |
| Mất phiên Chrome | | | | | |
| Hết hạn mức AI | | | | | |
| Lỗi kênh báo | | | | | |

## 10. Số liệu mô phỏng (chỉ để minh hoạ công cụ)

Lần chạy `cargo test -p dealsonar-core --test soak_simulation` (AI giả theo luật, 3 Radar chung nguồn, đã bật Pro để có 3 Radar chạy), với số bài thu nhỏ đại diện cho một tuần:

| Cấu hình | Bài thu | Cặp bài–Radar | Cặp cần AI | Lần gọi AI | Tin tạo / tin gửi |
|---|---|---|---|---|---|
| 5 group vắng | 10 | 30 | 25 | 3 | 6 / 6 |
| 10 group trung bình | 50 | 150 | 130 | 9 | 27 / 27 |
| 10 group sôi động | 120 | 360 | 320 | 16 | 54 / 39 (15 tin không có thông báo ngay: tin điểm thấp, hoặc Radar vượt ngưỡng tin mỗi giờ nên chuyển sang gửi gộp) |

Không dùng các số này làm kết quả đo: bài là văn bản tổng hợp, độ trễ gần bằng 0, AI và Telegram là giả.
