# Pilot 4 tuần và quyết định phạm vi phát hành

Trạng thái: **chưa mời người dùng nào, chưa có số liệu, chưa có quyết định.** Tài liệu này là quy trình, quy tắc chấm, cổng điều kiện tiên quyết và công cụ. Công cụ không bao giờ đưa ra quyết định "mở rộng"; nó chỉ cho biết bằng chứng nào có, bằng chứng nào thiếu, và gắn cờ một quyết định ghi tay mâu thuẫn với bằng chứng.

Nguồn: [PRD §8](../../../product/01-prd.md) (chỉ số thành công) và [Kế hoạch kiểm chứng](../../02-validation-plan.md). Mọi ngưỡng và cỡ mẫu dưới đây phải được chủ dự án **duyệt trước khi ghi danh người đầu tiên** (kế hoạch kiểm chứng yêu cầu duyệt trước khi đo). Mọi thay đổi sau đó ghi ở §10.

## 1. Chỉ số và định nghĩa (đã chốt)

| Chỉ số | Định nghĩa | Ngưỡng |
|---|---|---|
| Kích hoạt | Số người **cài xong** có radar đang chạy **trong phiên đầu** / số người cài xong | >= 60% |
| Thời gian tới tin đầu | Từ lúc bật radar đến tin khớp đầu tiên, trung vị | < 24 giờ |
| Tỉ lệ tin sai | Tin đã báo bị người dùng đánh dấu sai / tin đã báo, gộp mọi người | < 15% |
| Giữ chân tuần 4 | Số người còn radar chạy ở tuần 4 / số người cài xong đã tới tuần 4 | >= 40% |

Quy ước, áp dụng như nhau cho mọi người:

- **Ghi danh**: người đã đồng ý tham gia và được cấp bản cài. Mẫu số của mọi tỉ lệ nói rõ là ghi danh hay cài xong.
- **Cài xong**: hoàn tất hướng dẫn lần đầu (Chrome, Facebook, AI) và mở được ứng dụng. `install_completed` do người phụ trách xác nhận.
- **Phiên đầu**: radar được bật trong vòng **120 phút** kể từ lần mở ứng dụng đầu tiên (ứng dụng ghi mốc này ở "Hành trình", xem [Luồng người dùng §6.1](../../../product/03-ux-flows.md)). Nếu người phụ trách quan sát trực tiếp một phiên khác với phép tính này, ghi `activated_first_session` và giá trị ghi tay thắng số tính.
- **Tin đầu**: tính từ lúc bật radar đầu tiên (`first_radar_activated_at`), không phải từ lúc cài hay lúc tạo. Người đã bật radar mà chưa có tin sau 24 giờ **tính là quá 24 giờ**; trong 24 giờ đầu thì chưa tính cho tới khi hết cửa sổ.
- **Tin sai**: tin đã gửi (`notified_at`) mà người dùng đánh dấu không liên quan, người cùng nghề, trùng hoặc rác ngoài màn xem thử. Ứng dụng tính sẵn `leads_notified` và `leads_flagged_wrong`.
- **Còn radar chạy ở tuần 4**: có ít nhất một radar `active` ở ảnh chụp lấy từ ngày thứ 28 kể từ ngày ghi danh trở đi. Người bỏ cuộc tính là không còn.
- **Người bỏ cuộc** vẫn nằm trong mẫu số kích hoạt và giữ chân. Không loại ai khỏi mẫu số vì "không phù hợp" sau khi đã ghi danh.

### Khi nào được kết luận

| Chỉ số | Chỉ kết luận khi |
|---|---|
| Kích hoạt | Có ít nhất **10** người cài xong |
| Tới tin đầu | Mọi người đã bật radar đã qua cửa sổ 24 giờ hoặc đã có tin, và có ít nhất 10 người bật radar |
| Tin sai | Có ít nhất **30** tin đã báo |
| Giữ chân | Có ít nhất 10 người cài xong **và mọi người cài xong đã tới tuần 4 và có số liệu** (thiếu số liệu thì chưa kết luận, không đoán) |

Theo nhu cầu (ngành `bds`, `dich-vu-nha-cua`, `xe-cu`, `other`) dùng cùng quy tắc với cỡ mẫu nhỏ hơn: ít nhất **3** người cài xong và **10** tin đã báo. Một ngành là:

- **Đạt**: cả bốn chỉ số đủ dữ liệu và đều đạt.
- **Cần sửa**: có ít nhất một chỉ số đủ dữ liệu và **không đạt**.
- **Chưa đủ bằng chứng**: còn lại, kể cả ngành chưa có ai.

Cỡ mẫu 10, 30 và 3 là đề xuất để chủ dự án duyệt hoặc thay (ghi ở §10). Với mẫu nhỏ, số liệu chỉ có tính định hướng.

## 2. Phần phải có trước khi mời người dùng (cổng điều kiện)

`pnpm pilot:gate` (hay `node scripts/pilot-report.mjs gate`) in từng mục. Pilot chỉ được mời người dùng khi **mọi mục đã có bằng chứng** hoặc có waiver ghi rõ lý do của chủ dự án.

| Mục | Nguồn bằng chứng | Trạng thái hiện tại |
|---|---|---|
| #7 Bản cài khách hàng cài và ghép nối được trên máy sạch, mọi nền tảng cam kết | `docs/delivery/distribution-evidence.json` (do `scripts/distribution-evidence.mjs` kiểm) | **Chưa có.** Sổ ghi trống |
| #14 Quan sát 8 người: H4 tự kết nối CLI, H1 tạo Radar dùng được | `docs/delivery/studies/h1-h4/sessions.json` | **Chưa có.** 0/8 phiên |
| #9 Hướng dẫn lần đầu, giải thích khi chưa có tin, mốc cài | Mã nguồn và kiểm thử | Có (commit `a57b754`) |
| #8, #11, #12 | Kết quả các worker đó bàn giao | **Chưa bàn giao.** Điền `evidence_ref` khi có; cổng đọc lại mỗi lần chạy |
| Chủ dự án duyệt ngưỡng, cỡ mẫu và định nghĩa "phiên đầu" | `prerequisites.json` | **Chưa.** Cần chủ dự án |
| Tuyển người dùng pilot, đủ ngành, mang nhu cầu thật | `prerequisites.json` | **Chưa.** Cần chủ dự án |
| Văn bản đồng ý (rủi ro tài khoản Facebook, dữ liệu ở trên máy, số liệu chỉ gồm số đếm và thời gian) | `prerequisites.json` | **Chưa.** Cần chủ dự án |
| Kênh hỗ trợ, người trả gói AI nếu người dùng chưa có, lịch phỏng vấn tuần 2 | `prerequisites.json` | **Chưa.** Cần chủ dự án |

H5 (an toàn tài khoản, #13) chạy song song và không chặn việc mời pilot, nhưng bắt buộc có trước quyết định mở rộng (§6).

Một mục chỉ được đánh dấu `met` khi có `evidence_ref` (commit, mục trong sổ, bản ghi có ngày). Mục đánh dấu đạt mà không có `evidence_ref` vẫn tính là chưa đạt. Waiver (`waivers` trong `prerequisites.json`) cần `item`, `date`, `by` và `rationale`, và được in nguyên văn trong báo cáo.

## 3. Thu thập số liệu

Ứng dụng không có máy chủ và không gửi số liệu đi. Mỗi người dùng chủ động gửi cho người phụ trách (PRD §8, cách (a)).

1. Vào màn **Kết nối** → "Hành trình từ lúc cài đến tin đầu tiên" → **Sao chép số liệu pilot (JSON)**. Nội dung chỉ gồm số đếm và thời gian: mốc cài, tạo, bật radar, tin đầu, số radar đang chạy, số tin đã báo và bị đánh dấu sai, số lượt gọi AI và token. Không có nội dung bài, tên nhóm, tên tài khoản Facebook, tên hay liên hệ của ai.
2. Lấy ảnh chụp vào **ngày ghi danh + 0** (sau khi cài), **+14** (cùng buổi phỏng vấn) và **+28** (hoặc ngày đầu tiên sau đó). Ảnh +28 là căn cứ cho "còn radar chạy ở tuần 4".
3. Người phụ trách dán JSON vào `snapshots` của người đó trong `participants.json`. Công cụ lấy mọi giá trị đo được từ ảnh chụp mới nhất tính đến `--as-of`.

Riêng tư: mã `U01`, `U02`…, không ghi tên, email, số điện thoại, tên nhóm hay nội dung bài vào repo. Ảnh chụp màn hình chỉ giữ ngoài repo.

### Bản ghi một người

```json
{
  "id": "U01",
  "segment": "bds",
  "enrolled_on": "2027-01-04",
  "consent": true,
  "install_completed": true,
  "snapshots": [],
  "dropout": { "on": "2027-01-20", "stage": "ongoing", "reason": "no_leads", "note": "…" },
  "interview_week2": {
    "on": "2027-01-18",
    "handled": 2,
    "handled_note": "…",
    "ai_plan": "had_before",
    "ai_monthly_cost_vnd": 500000,
    "ai_limit_hit": false,
    "ai_affected_other_use": false,
    "note": "…"
  }
}
```

Chỉ là định dạng, không phải dữ liệu; không thêm bản ghi mẫu vào `participants.json`. `dropout` bỏ trống nếu chưa bỏ cuộc. `stage`: `install`, `activation`, `first_lead`, `ongoing`. `reason`: `chrome_setup`, `ai_setup`, `facebook_setup`, `no_leads`, `wrong_leads`, `account_risk`, `cost`, `no_time`, `technical_fault`, `other`; luôn kèm `note` bằng lời của người dùng.

## 4. Phỏng vấn sau 2 tuần

Cho mỗi người đã cài xong, ở ngày thứ 14, kể cả người đã bỏ cuộc (hỏi vì sao). Ghi:

1. **Việc thực tế đã xử lý** (`handled`): trong 2 tuần, bao nhiêu khách hay việc thật bạn đã liên hệ hoặc chốt nhờ tin DealSonar báo? Chuyện gì xảy ra? Mỗi việc đáng khoảng bao nhiêu (ghi vào `handled_note`, không ghi tên khách).
2. **Chi phí AI**: bạn đã có gói AI trước khi dùng DealSonar không (`had_before`), mua riêng cho việc này (`bought_for_this`) hay chưa có (`none`)? Bạn trả bao nhiêu mỗi tháng (`ai_monthly_cost_vnd`)?
3. **Hạn mức**: gói AI của bạn có bị chạm giới hạn trong 2 tuần không (`ai_limit_hit`)? DealSonar có làm ảnh hưởng việc bạn dùng AI cho việc khác không (`ai_affected_other_use`)? Kế hoạch kiểm chứng đặt mục tiêu không ai báo.
4. **Tin sai**: tin nào làm bạn khó chịu nhất, vì sao? Bạn có tin các trường đã trích đủ để không mở bài gốc không?
5. **Sẽ tiếp tục không**: nếu không có chúng tôi nhắc, tuần sau bạn còn mở ứng dụng không? Cần thêm gì?

Báo cáo nêu số người đến hạn, số đã phỏng vấn và tên người còn thiếu. Một người chạm hạn mức hoặc bị ảnh hưởng việc dùng AI khác làm mục "Radar không làm cạn hạn mức gói AI" thành **không đạt**.

## 5. Chạy báo cáo

```
pnpm pilot:gate                          # điều kiện tiên quyết trước khi mời
pnpm pilot:report -- --as-of 2027-02-10  # chỉ số, người bỏ cuộc, phỏng vấn, theo ngành
pnpm pilot:decision -- --as-of 2027-02-10  # bằng chứng cho quyết định mở rộng
pnpm pilot:test                          # kiểm thử công cụ bằng bản ghi giả
```

Thêm `--json` để lấy dạng máy đọc. `--as-of` mặc định là hôm nay; dùng ngày cố định khi nộp báo cáo để kết quả lặp lại được.

## 6. Quyết định mở rộng

`pnpm pilot:decision` tổng hợp ba nhóm trước khi chủ dự án quyết định:

| Nhóm | Mục | Nguồn |
|---|---|---|
| Pilot | Kích hoạt, tới tin đầu, tin sai, giữ chân, phỏng vấn, hạn mức AI | `participants.json` |
| Tài khoản | H5: 0/3 tài khoản bị hạn chế sau 30 ngày | `studies/h5-account-safety/accounts.json` |
| Chất lượng | H2: trích xuất đúng trên tập chuẩn bằng CLI thật (không phải mock) | `prerequisites.json` → `expansion_evidence` |
| Vận hành | Độ trễ báo tin trung vị < 10 phút (G2); tỉ lệ gọi AI < 15% sau khi có bộ luật (G4) | `prerequisites.json` → `expansion_evidence` |

Báo cáo nêu rõ **nhu cầu (ngành) đạt**, **nhu cầu cần sửa** và **phần chưa đủ bằng chứng**. Với mục chất lượng và vận hành, `status` là `met` hoặc `failed` chỉ khi có `evidence_ref`; nếu không là chưa đủ bằng chứng.

Quyết định của chủ dự án ghi vào `decision.json` (file này **chưa tồn tại** và không được tạo trước khi có bằng chứng):

```json
{ "date": "2027-02-12", "decision": "fix_then_remeasure", "by": "owner", "rationale": "…", "scope": ["bds"] }
```

`decision`: `expand`, `expand_limited`, `fix_then_remeasure`, `stop`. Nếu ghi `expand*` khi bằng chứng chưa đủ hoặc có mục không đạt, công cụ in "MÂU THUẪN". Tiêu chí dừng ở [Kế hoạch kiểm chứng §7](../../02-validation-plan.md) vẫn áp dụng.

## 7. Việc người thật phải làm (chủ dự án)

1. Duyệt hoặc sửa các ngưỡng, cỡ mẫu (10 / 30 / 3 / 10) và định nghĩa "phiên đầu" ở §1; cập nhật §10.
2. Chuẩn bị bản cài khách hàng đã ký, đã có bằng chứng #7 trên mọi nền tảng cam kết.
3. Chạy và nhập nghiên cứu #14; chờ #8, #11, #12 bàn giao rồi điền `evidence_ref`.
4. Tuyển đủ người, đủ ngành; thu văn bản đồng ý; mở kênh hỗ trợ; đặt lịch phỏng vấn ngày 14.
5. Mỗi người: ba lần dán ảnh chụp số liệu (ngày 0, 14, 28), một buổi phỏng vấn, ghi bỏ cuộc và lý do ngay khi biết.
6. Chạy H2 trên tập chuẩn bằng CLI thật, đo G2 và G4, ghi `evidence_ref` vào `expansion_evidence`.
7. Chạy H5 (#13) 30 ngày trên ba tài khoản thử.

## 8. Bằng chứng còn thiếu hiện tại

| Mục | Trạng thái |
|---|---|
| Công cụ chấm, cổng tiên quyết, mẫu ghi chép, hướng dẫn phỏng vấn | Có, kiểm thử bằng bản ghi giả (`pnpm pilot:test`) |
| Ứng dụng xuất số liệu pilot (số đếm và thời gian, kể cả tin sai) | Có |
| Bằng chứng phân phối #7, nghiên cứu #14, kết quả #8/#11/#12 | **Chưa có** |
| Duyệt ngưỡng, tuyển người, đồng ý, hỗ trợ, phỏng vấn | **Chưa có** |
| Bất kỳ số liệu pilot, kết luận ngành đạt hay cần sửa, quyết định mở rộng | **Chưa có.** Không điền tay ngoài công cụ |

## 9. Hạn chế đã biết

- Không có máy chủ nên không có số liệu tự động; mọi số đến từ ảnh chụp người dùng chủ động gửi.
- "Giữ chân tuần 4" dựa vào số radar `active` ở thời điểm chụp, không chứng minh người dùng thực sự đọc tin.
- Tin sai chỉ tính khi người dùng bấm đánh dấu; người im lặng không được tính là hài lòng.
- Độ trễ báo tin (G2) và tỉ lệ gọi AI (G4) chưa nằm trong ảnh chụp; được thu riêng bằng `expansion_evidence`.

## 10. Nhật ký thay đổi quy tắc

Chưa có thay đổi.
