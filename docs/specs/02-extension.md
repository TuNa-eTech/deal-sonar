# Đặc tả extension Chrome

Trạng thái: nháp v0.1 · 2026-11-11

Extension có một việc: đọc bài mới trong các group người dùng đã tham gia, với tần suất thấp, và chuyển về desktop. Nó không biết radar là gì.

> **Lưu ý về độ chắc chắn.** Phần §4 mô tả cách trích bài từ Facebook dựa trên hiểu biết chung về cách trang này hoạt động. Facebook thay đổi thường xuyên và tôi chưa kiểm tra trên trang thật trong phiên làm việc này. Mọi chi tiết về cấu trúc phản hồi và bộ chọn DOM phải được xác nhận ở spike S1 ([Lộ trình](../delivery/01-roadmap.md)) trước khi coi là đúng.

## 1. Thành phần

| Phần | File | Ngữ cảnh | Việc |
|---|---|---|---|
| Service worker | `src/background/` | Extension | Giữ cổng native, lập lịch, mở và đóng tab quét, hàng đợi gửi, trạng thái |
| Tap | `src/content/tap.ts` | Trang, thế giới `MAIN`, `document_start` | Sao chép phản hồi mạng liên quan tới feed và chuyển cho content script |
| Bộ trích | `src/content/extract.ts` | Trang, thế giới cô lập | Áp `ExtractorProfile` lên dữ liệu từ tap, dữ liệu nhúng và DOM; tạo `RawPost` |
| Điều khiển trang | `src/content/drive.ts` | Trang, thế giới cô lập | Cuộn, mở "Xem thêm", phát hiện trạng thái phiên |
| Popup | `src/popup/` | Extension | Hiện trạng thái, tạm dừng, theo dõi group hiện tại |

## 2. Manifest

Thay đổi so với [manifest hiện tại](../../apps/extension/public/manifest.json):

```jsonc
{
  "manifest_version": 3,
  "minimum_chrome_version": "116",          // giữ như hiện tại; đủ cho content script ở thế giới MAIN
  "permissions": ["nativeMessaging", "storage", "alarms", "tabs", "scripting", "idle"],
  "host_permissions": ["https://www.facebook.com/groups/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://www.facebook.com/groups/*"], "js": ["tap.js"],
      "world": "MAIN", "run_at": "document_start" },
    { "matches": ["https://www.facebook.com/groups/*"], "js": ["content.js"],
      "run_at": "document_idle" }
  ]
}
```

Quyền xin ở mức tối thiểu: chỉ phần `/groups/` của `facebook.com`, không `<all_urls>`, không `cookies`, không `webRequest`, không `debugger`. Extension không đọc cookie và không gửi dữ liệu đi đâu ngoài native host. Trang danh sách group đã tham gia cũng nằm dưới `/groups/`; việc nhận biết bị chuyển hướng sang trang đăng nhập dựa vào địa chỉ của tab (quyền `tabs`), không cần quyền trên trang đó.

## 3. Dữ liệu thu

**Thu:** bài viết trong feed của group đang theo dõi: ID bài, đường dẫn, tên hiển thị và ID của người đăng, nội dung chữ, thời điểm đăng, siêu dữ liệu đính kèm (loại, đường dẫn, chữ thay thế của ảnh), số bình luận và lượt tương tác. Cấu trúc ở [Giao thức §4.3](01-protocol.md#43-kiểu-dữ-liệu), kiểu `RawPost`.

**Không thu:** danh sách thành viên, trang cá nhân, bình luận (D-8), tin nhắn, nội dung ảnh và video, bài ngoài các group trong kế hoạch quét, bất cứ thứ gì trên các trang khác của Facebook.

Số điện thoại chỉ được lấy khi nó nằm trong nội dung bài do chính người đăng viết ra.

## 4. Chiến lược trích bài

Ba chiến lược, thử theo thứ tự trong `ExtractorProfile.strategies`. Mỗi bài ghi lại chiến lược đã dùng để desktop theo dõi tỉ lệ.

### 4.1 `network`: đọc phản hồi mạng (chính)

Trang Facebook tải feed qua các yêu cầu tới điểm cuối GraphQL nội bộ. `tap.ts` chạy trong thế giới `MAIN` bọc `fetch` và `XMLHttpRequest`, **chỉ sao chép** phần thân phản hồi của các yêu cầu khớp mẫu đường dẫn trong profile, rồi gửi sang content script bằng `window.postMessage`. Nó không sửa, không chặn, không tự phát yêu cầu nào.

Bộ trích duyệt cây JSON tìm các nút có dấu hiệu là bài viết theo quy tắc trong `ExtractorProfile.network`:

```jsonc
{
  "url_patterns": ["/api/graphql/"],
  "story_markers": [{"path": "__typename", "equals": "Story"}],
  "fields": {
    "post_id":    ["post_id", "id"],
    "text":       ["message.text", "comet_sections.content.story.message.text"],
    "author_id":  ["actors[0].id"],
    "author_name":["actors[0].name"],
    "created_at": ["creation_time"],
    "permalink":  ["url", "wwwURL"]
  }
}
```

Các đường dẫn trên là **ví dụ minh hoạ định dạng**, không phải giá trị đã kiểm chứng.

Lý do chọn làm chiến lược chính: phản hồi mạng có sẵn ID bài, thời điểm đăng chính xác và đường dẫn, là ba thứ DOM của Facebook cố tình làm khó lấy.

### 4.2 `embedded`: đọc dữ liệu nhúng trong trang

Lần tải trang đầu tiên thường kèm dữ liệu của các bài đầu feed trong các thẻ `<script type="application/json">`. Bộ trích áp cùng quy tắc tìm nút như §4.1 lên các khối này. Chiến lược này lấy được các bài mới nhất mà không cần cuộn.

### 4.3 `dom`: đọc DOM (dự phòng)

Dùng khi hai chiến lược trên không cho ra bài nào. Tìm các phần tử bài viết trong vùng feed, lấy nội dung chữ và đường dẫn bài; thời điểm đăng thường không lấy được chính xác, khi đó `created_at` để trống và desktop dùng `captured_at` làm cận trên. Bộ chọn nằm trong `ExtractorProfile.dom`.

### 4.4 Khi bộ trích hỏng

Dấu hiệu: trang tải được, phiên bình thường, nhưng `posts_seen = 0` ở ba lần quét liên tiếp trên các nguồn khác nhau. Extension báo `crawl.report` với `status: "empty"`; desktop hiện cảnh báo "Facebook đã thay đổi, cần cập nhật DealSonar" và giảm tần suất quét xuống mức tối thiểu cho tới khi có profile mới.

### 4.5 Rủi ro kỹ thuật cần spike

| Câu hỏi | Vì sao quan trọng | Phương án nếu câu trả lời là "không" |
|---|---|---|
| Feed có tải trong tab không hiển thị không? | Trình duyệt hạn chế tab nền; cuộn và tải lười có thể không chạy | Dùng một cửa sổ riêng thu nhỏ; hoặc chỉ dựa vào `embedded` (không cần cuộn) với chu kỳ ngắn hơn |
| Sắp xếp "Mới nhất" có đặt được qua tham số đường dẫn không? | Cần bài mới ở đầu để không phải cuộn sâu | Điều khiển trang chọn sắp xếp qua giao diện |
| Bọc `fetch` trong thế giới `MAIN` có bị trang phát hiện hoặc làm hỏng trang không? | Ảnh hưởng tới an toàn tài khoản | Chỉ dùng `embedded` + `dom` |
| Mỗi lần tải trang lấy được bao nhiêu bài mà không cuộn? | Quyết định chu kỳ quét cho group sôi động | Tăng số bước cuộn trong giới hạn chính sách |

## 5. Một lần quét

```
báo thức ─► chọn nguồn đến hạn ─► kiểm tra chặn cứng ─► mở tab ─► chờ tải
   ─► trích (network / embedded / dom) ─► cuộn tối đa N bước ─► gửi posts.push
   ─► đóng tab ─► crawl.report ─► đặt lịch lần sau
```

1. **Chọn nguồn.** Nguồn có thời điểm đến hạn sớm nhất; nguồn ưu tiên đứng trước khi cùng hạn. Mỗi lúc chỉ quét một nguồn.
2. **Kiểm tra chặn cứng** (§6). Không đạt thì hoãn tới khi đạt.
3. **Mở tab.** Tab không được kích hoạt (`active: false`), không cướp tiêu điểm. Nếu người dùng đang tự mở group đó ở một tab, dùng luôn dữ liệu từ tab ấy và không mở thêm (thu thụ động).
4. **Trích.** Chờ `document_idle` cộng một khoảng ngẫu nhiên 2–5 giây. Thu bài cho tới khi gặp bài đã thấy ở lần trước (so `post_id` với danh sách 200 ID gần nhất của nguồn, lưu trong `chrome.storage.local`), hoặc đạt `max_posts_per_visit`, hoặc hết `max_scroll_steps`.
5. **Cuộn.** Mỗi bước cuộn một màn hình, nghỉ ngẫu nhiên 1,5–4 giây.
6. **Kết thúc.** Đóng tab trong vòng 60 giây kể từ khi mở, dù kết quả thế nào.

**Quét theo yêu cầu** (`crawl.request`): cùng quy trình, bỏ qua lịch nhưng vẫn chịu chặn cứng. Với `reason: "preview"`, `max_posts` thường là 30–50.

## 6. Chính sách tần suất

Mục tiêu: hành vi của extension không khác đáng kể so với một người dùng thỉnh thoảng mở group xem bài mới.

### 6.1 Giá trị mặc định

| Tham số | Mặc định | Giới hạn người dùng chỉnh được |
|---|---|---|
| Chu kỳ mỗi group | 15 phút | 10–120 phút |
| Chu kỳ group ưu tiên | 5 phút | tối đa 3 group ưu tiên |
| Độ lệch ngẫu nhiên | ±30% | cố định |
| Tải trang mỗi giờ (toàn cục) | 60 | 20–90 |
| Tải trang mỗi ngày (toàn cục) | 600 | 100–900 |
| Giờ hoạt động | 07:00–23:00 | tuỳ ý |
| Bước cuộn mỗi lần | 3 | 0–5 |
| Bài tối đa mỗi lần | 30 | 10–50 |
| Tab quét đồng thời | 1 | cố định |

### 6.2 Phân bổ ngân sách

Desktop tính chu kỳ cho từng nguồn sao cho tổng không vượt ngân sách giờ:

- Nguồn nhiều bài mới (trung bình trên 10 bài mỗi lần quét) được rút chu kỳ về mức tối thiểu.
- Nguồn ít bài (dưới 1 bài mỗi lần quét trong 24 giờ) được giãn dần tới 60 phút.
- Với 10 group ở 15 phút: 40 lần tải mỗi giờ. Với 50 group, ngân sách 60 lần mỗi giờ buộc chu kỳ trung bình là 50 phút; đây là giới hạn thật của gói Chuyên nghiệp và phải nói rõ với người dùng.

### 6.3 Chặn cứng trong extension

Thực thi độc lập với desktop và không tắt được qua `config.update`:

- Trần tuyệt đối: 90 lần tải mỗi giờ, 900 mỗi ngày, bất kể chính sách nhận được.
- Chu kỳ tối thiểu tuyệt đối cho một nguồn: 4 phút.
- Dừng toàn bộ khi `session.state` khác `ok`.

### 6.4 Phản ứng với dấu hiệu bất thường

| Dấu hiệu | Phản ứng |
|---|---|
| Trang đăng nhập thay cho trang group | `session.status: logged_out`; dừng; chờ người dùng đăng nhập |
| Trang yêu cầu xác minh danh tính | `session.status: checkpoint`; dừng; **không** tự tiếp tục, người dùng phải bấm "Tiếp tục" trong app |
| Thông báo hạn chế tạm thời | `session.status: rate_limited`; dừng 24 giờ; khi chạy lại thì chu kỳ nhân đôi trong 7 ngày |
| Group không truy cập được (bị rời, bị xoá) | Đánh dấu nguồn lỗi; bỏ khỏi lịch; báo desktop |
| Ba lần tải lỗi mạng liên tiếp | Lùi dần: 5, 15, 60 phút |

## 7. Phát hiện group đã tham gia

- Khi người dùng mở trang danh sách group của họ trên Facebook, bộ trích đọc danh sách và gửi `sources.discovered`.
- Khi người dùng ở trong một group, popup có nút "Theo dõi group này", gửi `sources.discovered` với `follow: true`.
- Extension không tự mở trang danh sách group; app desktop có nút mở trang đó giúp người dùng.

## 8. Lưu trữ trong extension

| Kho | Nội dung |
|---|---|
| `chrome.storage.local` | `profile_id`, `config` (kế hoạch, chính sách, profile bộ trích), bộ đếm tải theo giờ và ngày, 200 `post_id` gần nhất mỗi nguồn, trạng thái tạm dừng |
| IndexedDB | Hàng đợi gửi (message chưa được `ack`) |

Extension không lưu nội dung bài lâu hơn mức cần để gửi đi.

## 9. Vòng đời service worker

- Cổng `connectNative` đang mở giữ service worker sống. Nếu cổng đóng, worker có thể bị dừng sau khoảng 30 giây.
- Một báo thức `keepalive` mỗi phút đánh thức worker để thử nối lại và kiểm tra lịch.
- Mọi trạng thái cần sống qua lần dừng nằm trong `chrome.storage.local` hoặc IndexedDB; không dựa vào biến toàn cục.

## 10. Kiểm thử

- **Bộ trích:** kiểm thử đơn vị trên các mẫu phản hồi và HTML đã lưu (đã xoá thông tin cá nhân) trong `apps/extension/fixtures/`. Mỗi lần Facebook đổi cấu trúc, thêm mẫu mới.
- **Lập lịch và chặn cứng:** kiểm thử đơn vị với đồng hồ giả.
- **Hàng đợi gửi:** kiểm thử gửi lại, khử trùng, tràn hàng đợi với native host giả.
- **Đầu cuối:** thủ công trên một tài khoản thử và các group thử; không tự động hoá trên Facebook thật trong CI.
