# Nghiên cứu quan sát H1 và H4: tự cài AI và tự tạo Radar từ nhu cầu thật

Trạng thái: **chưa có người tham gia nào. Chưa có kết quả.** Tài liệu này là quy trình, mẫu ghi chép và công cụ chấm; số liệu chỉ có sau khi đủ 8 phiên thật.

Nguồn ngưỡng: [Kế hoạch kiểm chứng §2 (H1) và §5 (H4)](../../02-validation-plan.md). Ngưỡng được chốt **trước khi đo** và không đổi sau khi phiên đầu tiên chạy. Việc đổi ngưỡng phải ghi vào cuối tài liệu này kèm lý do và ngày.

## 1. Mục tiêu

Tách hai rào cản mà người dùng dễ gộp làm một:

1. **Kết nối CLI AI** (H4): người không rành kỹ thuật có tự cài và đăng nhập một CLI AI chỉ bằng hướng dẫn trong app không?
2. **Tự định nghĩa một Radar dùng được** (H1): khi AI đã nối sẵn, họ có đi từ "Tạo radar" tới radar `active` mà dùng được không?

Hai phần được đo riêng, với hai đồng hồ riêng và hai cột riêng trong bản ghi, để một lỗi cài AI không bị tính nhầm là lỗi tạo Radar.

## 2. Ngưỡng đạt (đã chốt)

| Giả thuyết | Phép đo | Ngưỡng đạt |
|---|---|---|
| H4 | Tự kết nối CLI không cần trợ giúp | >= 5/8 |
| H4 | Thời gian kết nối CLI, trung vị | < 10 phút |
| H1 | Thời gian từ bấm "Tạo radar" tới radar `active`, trung vị | < 5 phút |
| H1 | Số người dưới 7 phút | >= 6/8 |
| H1 | Tự hoàn thành không cần trợ giúp | >= 6/8 |
| H1 | Radar dùng được: >= 70% bài được chấm khớp ở màn xem thử là bài người tham gia xác nhận muốn nhận | >= 6/8 |

Quy ước tính:

- **Không cần trợ giúp**: người quan sát không nói hay chỉ gì để họ đi tiếp. Mỗi lần họ hỏi hoặc người quan sát phải can thiệp đều ghi vào `help_requests`, kể cả khi người quan sát từ chối giúp.
- **Thời gian trung vị** lấy trên cả 8 người. Người chưa thành công (bỏ cuộc hoặc hết 30 phút) tính bằng 30 phút. Người thành công có trợ giúp tính bằng thời gian thực.
- **Dùng được** chỉ tính khi radar đã `active` và màn xem thử có ít nhất một bài khớp. Người tham gia tự đánh dấu từng bài khớp là "đúng, tôi muốn nhận" hay "không" (cách lấy đánh giá ở §5). Người quan sát không đánh giá thay.
- Đủ kết luận khi có **đúng 8 phiên hợp lệ**, mỗi ngành trong bds, dich-vu-nha-cua, xe-cu ít nhất 2 người. Thiếu một trong hai thì công cụ chỉ báo "chưa có đủ bằng chứng".

## 3. Người tham gia

- 8 người **không làm nghề kỹ thuật**, đang tự lướt group để tìm khách hoặc tìm việc, mang **nhu cầu thật của chính họ**.
- Ít nhất 2 người mỗi ngành: bất động sản (`bds`), dịch vụ nhà cửa (`dich-vu-nha-cua`), xe cũ (`xe-cu`).
- Không tuyển người đã xem bản thiết kế hay đã dùng DealSonar.
- Chỉ ghi mã `P01`…`P08`. Không ghi tên, số điện thoại, tên group riêng tư hay nội dung bài của người khác vào bản ghi, ảnh chụp hay file nộp vào repo. Ghi âm hoặc quay màn hình chỉ khi họ đồng ý, lưu ngoài repo và xoá khi báo cáo xong.
- Mỗi người đọc và đồng ý ghi chép trước khi bắt đầu (`consent: true`). Họ được dừng bất kỳ lúc nào.

## 4. Chuẩn bị

Người phụ trách tuyển người và chạy phiên là chủ nghiên cứu, không phải bản thân sản phẩm. Các việc sau cần người thật:

1. Chốt bản dựng thử: ghi mã commit của nhánh tích hợp #2/#4/#9 vào bản ghi phiên. Chỉ dùng một bản dựng cho cả 8 người.
2. Hai loại máy:
   - **Máy sạch cho H4**: chưa cài `claude`, `codex`, `agy`, chưa đăng nhập dịch vụ AI nào. Mỗi người một máy sạch (hoặc khôi phục ảnh máy).
   - **Máy đã nối AI cho H1**: app đã cài, AI đã nối bằng tài khoản của người quan sát, Telegram đã nối (theo kế hoạch kiểm chứng §2), Chrome extension đã ghép nối, Facebook đã đăng nhập bằng **tài khoản thử**, các group liên quan ngành của người tham gia đã được theo dõi và trong kho đã có bài của ngành đó.
3. Quyết định trước ai trả phí gói AI nếu người tham gia chưa có. Người tham gia không phải trả tiền hay nhập thẻ của chính họ trong phiên; nếu họ dừng lại ở bước thanh toán thì ghi blocker `cli-payment` và người quan sát đăng nhập bằng tài khoản thử để cả phiên H1 vẫn chạy được.
4. In `observer-sheet.md` cho mỗi người, đồng hồ bấm giây, màn hình quay lại nếu có đồng ý.

## 5. Quy trình một phiên (khoảng 60 phút)

**Giới thiệu (3 phút).** Đọc lời dẫn: "Chúng tôi đang thử phần mềm, không phải thử bạn. Mình sẽ không chỉ bạn cách dùng. Bạn cứ nói to điều bạn nghĩ. Bạn dừng lúc nào cũng được." Xin đồng ý ghi chép.

**Phần A: kết nối CLI AI (H4), máy sạch.**
- Nhiệm vụ: "Hãy làm cho ứng dụng nối được với một công cụ AI, chỉ dùng hướng dẫn trong ứng dụng."
- Bắt đầu bấm giờ khi họ mở bước **Kết nối** (bước 2 của hướng dẫn đầu tiên). Dừng khi dòng AI trong danh sách kiểm tra chuyển sang **Sẵn sàng**, hoặc họ bỏ cuộc, hoặc hết 30 phút.
- Ghi từng lần họ dừng, hỏi hay mở trang ngoài: ở đâu (`cli:cai-dat`, `cli:dang-ky`, `cli:dang-nhap`, `cli:thanh-toan`, `cli:khac`), làm gì để đi tiếp.
- Nếu họ bỏ cuộc: ghi thời điểm, lý do, rồi người quan sát nối CLI giúp để họ vẫn làm được phần B. Không đánh giá phần B của họ khác đi.

**Nghỉ ngắn, chuyển sang máy đã nối AI.**

**Phần B: tạo Radar từ nhu cầu thật (H1).**
- Nhiệm vụ nguyên văn: "Hãy làm cho ứng dụng báo cho bạn khi có **[thứ bạn thường tìm]**." Không hướng dẫn thêm.
- Bắt đầu bấm giờ khi họ bấm **Tạo radar**. Dừng khi radar `active`, họ bỏ cuộc, hoặc hết 30 phút.
- Người quan sát chỉ can thiệp khi họ bỏ cuộc.
- Trong lúc đó ghi: lời họ nói khi dừng lâu nhất, độ dài và từ ngữ họ viết ở mô tả, số trường họ sửa, họ có hiểu màn xem thử không.
- **Giả định của ứng dụng.** Ở màn "AI hiểu nhu cầu của bạn", ghi từng dòng **Giả định** và các lựa chọn phía giao dịch và đối tượng bị loại. Hỏi sau phiên hoặc quan sát: dòng nào sai so với ý họ, họ sửa thế nào.
- **Câu hỏi làm rõ.** Nếu app hỏi phía giao dịch, ghi họ chọn gì và có hiểu câu hỏi không.
- Đánh giá bài khớp **không** nằm trong thời gian đo: khi màn xem thử hiện danh sách bài khớp, người quan sát chụp màn hình (lưu ngoài repo, xoá khi báo cáo xong) mà không nói gì, để họ tự quyết bấm **Bật radar**. Sau khi đồng hồ dừng, đưa họ xem lại ảnh và để họ tự chọn **đúng, tôi muốn nhận** hoặc **không** cho từng bài khớp. Ghi `confirmed / shown`. Thử cách này một lần trước phiên đầu tiên; nếu app cho xem lại danh sách xem thử của radar vừa bật thì dùng thẳng màn đó thay cho ảnh.

**Hậu phỏng vấn (10 phút).** Chỗ nào họ thấy khó nhất? Họ định tin app tới đâu? Họ sẽ làm gì nếu không có người ngồi cạnh?

**Đối chiếu số liệu của app.** Mở màn **Kết nối**, phần "Hành trình từ lúc cài đến tin đầu tiên", chụp hoặc chép giờ **Mở DealSonar lần đầu**, **Tạo Radar đầu tiên** và **Bật Radar đầu tiên**. Đối chiếu với đồng hồ bấm giờ; nếu lệch hơn 1 phút thì ghi lý do. Thời gian cài và thời gian tạo Radar là hai số khác nhau, không dùng lẫn.

## 6. Ghi bản ghi và chấm

1. Mỗi người điền `observer-sheet.md`, rồi đưa vào `sessions.json` theo mẫu dưới. Giá trị chuẩn cho `step` của blocker: `cli`, `describe`, `fields`, `sources`, `preview`, `activate`.
2. `node scripts/study-report.mjs` (hoặc `pnpm study:report`) in kết quả. Dùng `--json` cho máy đọc, `--strict` để thoát mã 2 nếu chưa đạt cả hai giả thuyết.
3. Công cụ từ chối kết luận khi chưa đủ 8 phiên hợp lệ hoặc thiếu độ phủ ngành, và in ra phần còn thiếu.

```json
{
  "id": "P01",
  "industry": "bds",
  "technical": false,
  "consent": true,
  "build": "<mã commit>",
  "cli": {
    "succeeded": true,
    "completed_unaided": false,
    "minutes": 11.5,
    "help_requests": [{ "where": "cli:dang-nhap", "note": "không biết mở Terminal" }]
  },
  "radar": {
    "activated": true,
    "completed_unaided": true,
    "minutes": 4.2,
    "fields_edited": 1,
    "description_words": 14,
    "usable": { "confirmed": 8, "shown": 10 },
    "help_requests": []
  },
  "blockers": [
    { "id": "cli-login", "step": "cli", "summary": "Không biết mở Terminal để đăng nhập", "blocks_activation": false, "fix": "Người quan sát chỉ cách mở" }
  ],
  "wrong_assumptions": [
    { "assumption": "Loại bài của người cùng nghề", "step": "fields", "fix": "Bỏ chọn ô loại người cùng nghề", "blocks_activation": false }
  ]
}
```

Đây chỉ là mẫu định dạng, không phải dữ liệu. Không thêm bản ghi mẫu vào `sessions.json`.

## 7. Ưu tiên sửa lỗi

- Mỗi blocker có `id` ngắn, dùng đúng một `id` cho cùng một vấn đề ở các người khác nhau để đếm số người bị ảnh hưởng.
- `blocks_activation: true` khi người tham gia không bật được radar nếu không có trợ giúp vì lỗi đó.
- Báo cáo xếp lỗi **chặn bật trước**, rồi theo **số người bị ảnh hưởng**. Lỗi gặp ở một người vẫn ghi lại nhưng đứng dưới.
- Với mỗi lỗi ở top, ghi hướng xử lý theo bảng "nếu không đạt" của kế hoạch kiểm chứng (§2, §5): kẹt ở mô tả, ở trường, ở xem thử vì chờ; với H4 theo thứ tự: app tự cài CLI, provider API, dịch vụ AI do sản phẩm cung cấp.

## 8. Kết quả và bằng chứng còn thiếu

| Mục | Trạng thái |
|---|---|
| Công cụ chấm và quy trình | Có (đã kiểm thử bằng bản ghi giả, `pnpm study:test`) |
| Tuyển 8 người, 2 người mỗi ngành | **Chưa làm. Cần chủ nghiên cứu.** |
| Máy sạch và máy đã nối AI, tài khoản Facebook thử, tài khoản AI thử | **Chưa chuẩn bị. Cần chủ nghiên cứu.** |
| 8 phiên đã chạy và nhập vào `sessions.json` | **Chưa có.** |
| Kết luận H1, H4 | **Chưa có.** Không điền tay ngoài công cụ. |

## 9. Nhật ký thay đổi ngưỡng

Chưa có thay đổi.
