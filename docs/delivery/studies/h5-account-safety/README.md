# Quan sát an toàn tài khoản 30 ngày (H5)

Trạng thái: **chưa có tài khoản nào được theo dõi. Chưa có kết quả.** Tài liệu này là quy trình, quy tắc chấm và công cụ; số liệu chỉ có sau khi đủ ngày quan sát thật.

Nguồn: [Kế hoạch kiểm chứng §6](../../02-validation-plan.md). Các quy tắc dưới đây được chốt **trước khi quan sát** và không đổi sau khi tài khoản đầu tiên bắt đầu. Mọi đổi quy tắc ghi ở §9 kèm ngày và lý do.

## 1. Câu hỏi

Ở cấu hình quét mặc định, theo dõi 10 group, tài khoản Facebook có bị hạn chế hoặc khoá trong 30 ngày không? Mục tiêu: **0/3**. Ba tài khoản không đủ để kết luận thống kê; kết quả chỉ loại được trường hợp tệ nhất.

## 2. Tài khoản và cấu hình

- Ít nhất **3 tài khoản thử**, mỗi tài khoản theo dõi **đúng 10 group** mà chủ tài khoản là thành viên hợp lệ.
- Tuổi tài khoản và mức hoạt động **khác nhau** (`account_age`: `under-1y`, `1-3y`, `over-3y`; `activity`: `low`, `medium`, `high`). Công cụ cảnh báo nếu cả ba trùng.
- Cấu hình quét là **mặc định** của bản dựng đang thử (`CrawlPolicySettings::default()`):

| Thông số | Mặc định |
|---|---|
| Chu kỳ quét nhóm thường | 15 phút |
| Chu kỳ quét nhóm ưu tiên | 5 phút |
| Ngân sách tải trang | 60 lần/giờ, 600 lần/ngày |
| Giờ hoạt động | 07:00–23:00 |
| Cuộn tối đa mỗi lượt | 3 bước |
| Số bài tối đa mỗi lượt | 25 |
| Chỉ quét khi máy rảnh | tắt |

- Tài khoản dùng cấu hình khác mặc định, hoặc không đúng 10 nhóm, được ghi và hiển thị nhưng **không tính** vào kết luận mặc định.
- Người thử được nói rõ rủi ro của tự động hoá trên Facebook và đồng ý bằng văn bản. Khuyến nghị không dùng tài khoản duy nhất không thể mất.
- **Riêng tư.** Chỉ dùng mã `A1`, `A2`, `A3`. Không ghi tên, email, số điện thoại, đường dẫn hồ sơ hay tên group riêng tư vào bản ghi, ảnh chụp hay file nộp vào repo.

## 3. Ứng dụng ghi gì

Từ bản dựng này, DealSonar tự ghi **nhật ký sự cố phiên Facebook** (`safety.account_incidents`), ngay khi extension báo trạng thái không bình thường:

| Sự kiện của extension | Loại ghi |
|---|---|
| Trang xác minh / checkpoint | `checkpoint` (xác minh) |
| Bị đăng xuất bất thường | `logged_out` |
| Thông báo giới hạn tốc độ | `rate_limited` |
| Không rõ | `unknown` |

Mỗi bản ghi có: thời điểm, chi tiết ngắn (đường dẫn hay dấu hiệu, cắt còn 160 ký tự), **số lần tải trang trong 24 giờ và 1 giờ trước đó** (cộng từ nhật ký quét), `scanning_paused` và thời điểm phiên ổn định lại (`resolved_at`). Cùng một sự cố báo lặp lại chỉ ghi một lần; chuyển sang loại sự cố khác thì ghi mục mới.

**Quét dừng** ở mọi sự cố đó: ứng dụng ra lệnh tạm dừng cho extension và trạng thái chuyển sang tạm dừng. Sau một lần xác minh, quét **không tự chạy lại**: người dùng phải bấm Tiếp tục sau khi phiên ổn định. Đăng xuất và giới hạn tốc độ tự mở lại khi extension báo phiên ổn định. Kiểm thử tự động: `crates/core/tests/account_safety.rs`.

Cách xem: màn **Kết nối** → "An toàn tài khoản Facebook (30 ngày)", nút "Sao chép báo cáo JSON". Báo cáo cũng nằm trong gói chẩn đoán dưới tên `account_safety.json`. Báo cáo có: cấu hình quét đang dùng, số nhóm đang theo dõi, **các ngày thật sự có quét** (`active_days`) và danh sách sự cố.

Ứng dụng **không** biết Facebook đã hạn chế hay khoá tài khoản; nó chỉ thấy thông báo giới hạn, xác minh hay đăng xuất. Việc xác nhận tài khoản bị hạn chế do chủ nghiên cứu ghi tay (§5).

## 4. Việc phải làm hằng ngày

Chủ nghiên cứu (người thật):

1. Mỗi ngày, mở ứng dụng và ghi ngày đó vào `observed_days` của từng tài khoản, hoặc dán báo cáo JSON mới nhất vào `app_reports` (các ngày có quét sẽ được tính thành ngày quan sát).
2. Nhìn trạng thái tài khoản trên Facebook (có thông báo hạn chế, yêu cầu xác minh danh tính, khoá không). Nếu có, ghi `restriction` hoặc `lock` vào `incidents`, kể cả khi ứng dụng không phát hiện.
3. Khi tài khoản yêu cầu can thiệp (xác minh, hạn chế), **không bấm Tiếp tục** trước khi xử lý trên Facebook và ghi sự cố. Không ép quét tiếp để cho đủ ngày.

Ngày không quan sát thì **không** điền. Công cụ chấm theo ngày thật sự có quan sát, không theo ngày lịch.

## 5. Bản ghi

`accounts.json` có hai phần: `accounts` và `decisions`. Một tài khoản:

```json
{
  "id": "A1",
  "account_age": "1-3y",
  "activity": "medium",
  "started_on": "2026-12-01",
  "build": "<mã commit>",
  "groups": 10,
  "config": { "group_interval_minutes": 15, "priority_interval_minutes": 5, "hourly_page_load_budget": 60, "daily_page_load_budget": 600, "active_hours": { "from": "07:00", "to": "23:00" }, "max_scroll_steps": 3, "max_posts_per_visit": 25, "only_when_idle": false },
  "observed_days": ["2026-12-01", "2026-12-02"],
  "app_reports": [],
  "incidents": [
    { "at": "2026-12-10T08:00:00Z", "kind": "restriction", "page_loads_24h": 212, "scanning_paused": true, "note": "Facebook hạn chế đăng nhóm 24 giờ" }
  ]
}
```

Loại sự cố (`kind`): `verification`, `logout`, `rate_limit_notice`, `other`, và hai loại **tính là tài khoản bị hạn chế**: `restriction` (Facebook hạn chế tài khoản) và `lock` (khoá). Báo giới hạn tốc độ (`rate_limit_notice`) và xác minh **không** tự tính là hạn chế.

Mỗi sự cố bắt buộc có `at`, `page_loads_24h` và `scanning_paused: true`. Nếu quét **không** dừng khi sự cố xảy ra thì đó là lỗi của ứng dụng: ghi `scanning_paused: false` trong note, công cụ sẽ từ chối bản ghi cho tới khi lỗi được sửa. Ví dụ trên chỉ là định dạng, không phải dữ liệu; không thêm bản ghi mẫu vào `accounts.json`.

## 6. Quy tắc chấm (đã chốt)

- **Đủ thời gian theo dõi:** từ ngày quan sát đầu tới cuối trải ít nhất **30 ngày lịch**, có ít nhất **27 ngày** thật sự có quan sát (90%), và **không có khoảng trống quá 3 ngày** liên tiếp.
- **Mẫu số** là số tài khoản (đúng cấu hình mặc định, 10 nhóm) đã đủ thời gian theo dõi **hoặc đã bị hạn chế**. Tài khoản bị hạn chế trước ngày 30 vẫn tính, không được loại vì "chưa đủ ngày".
- **Báo cáo:** `số tài khoản bị hạn chế / số tài khoản đủ thời gian`, đối chiếu mục tiêu **0/3**. Chỉ kết luận khi có ít nhất 3 tài khoản đủ điều kiện; trước đó ghi "chưa có đủ bằng chứng".
- **Đạt** khi 0 tài khoản bị hạn chế. Bất kỳ tài khoản nào bị hạn chế là **không đạt** và bắt buộc có quyết định điều chỉnh.
- **Xác minh:** ghi số lần mỗi tài khoản. Nếu **trung bình trên 1 lần mỗi tài khoản**, kế hoạch yêu cầu giảm tần suất mặc định một nửa và đo lại. Công cụ in "CẦN GHI QUYẾT ĐỊNH" cho tới khi có mục tương ứng trong `decisions`.
- Số lần tải 24 giờ trước mỗi sự cố được in cạnh sự cố để so với ngân sách 600 lần/ngày.

## 7. Quyết định điều chỉnh

Khi một điều kiện ở §6 xảy ra, thêm một mục vào `decisions`:

```json
{ "date": "2027-01-02", "trigger": "restriction", "action": "halve_frequency", "detail": "Chu kỳ nhóm 15 → 30 phút, ngân sách 300 lần/ngày; đo lại từ 2027-01-03 với tài khoản mới" }
```

`trigger` là `restriction` hoặc `verification_rate`. `action` do chủ nghiên cứu chọn (`halve_frequency`, `keep`, `other`) và phải có lý do. Theo [Kế hoạch kiểm chứng §7](../../02-validation-plan.md), nếu giảm tần suất làm tin tới chậm hơn 30 phút thì đó là tiêu chí dừng hoặc đổi hướng lớn, cần ghi riêng.

## 8. Chạy báo cáo

```
pnpm study:h5          # node scripts/account-safety-report.mjs
pnpm study:h5 --json   # cho máy đọc
pnpm study:h5:test     # kiểm thử công cụ bằng bản ghi giả
```

## 9. Bằng chứng còn thiếu và việc cần chủ nghiên cứu

| Mục | Trạng thái |
|---|---|
| Ghi sự cố, số lần tải 24 giờ trước, dừng quét | Có trong ứng dụng, có kiểm thử tự động |
| Công cụ chấm và quy tắc | Có, kiểm thử bằng bản ghi giả |
| 3 tài khoản thử, 10 nhóm mỗi tài khoản, cấu hình mặc định | **Chưa chuẩn bị. Cần chủ nghiên cứu.** |
| Sự đồng ý của người dùng tài khoản thử | **Chưa có. Cần chủ nghiên cứu.** |
| 30 ngày quan sát thật và nhập `accounts.json` | **Chưa bắt đầu.** |
| Kết luận H5 (x/3 bị hạn chế) | **Chưa có.** Không điền tay ngoài công cụ. |

Nhật ký thay đổi quy tắc: chưa có thay đổi.
