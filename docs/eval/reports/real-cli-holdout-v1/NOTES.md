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
