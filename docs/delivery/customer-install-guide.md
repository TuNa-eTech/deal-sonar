# Cài DealSonar (hướng dẫn cho khách hàng)

> **Trạng thái tài liệu: bản nháp để người thử làm theo.** Các liên kết tải về và liên kết cửa hàng Chrome ở dưới còn để trống cho đến khi chủ dự án phát hành bản khách hàng đầu tiên ([04-distribution.md](04-distribution.md)). Bản dựng hiện tại là **bản thử nội bộ**; nếu bạn đang thử bản nội bộ, dùng phần "Dành cho người thử nội bộ" ở cuối.

DealSonar gồm hai phần cài trên cùng một máy: **ứng dụng DealSonar** và **tiện ích DealSonar trên Chrome**. Hai phần tự nhận ra nhau, bạn không phải nhập mã nào.

## Bạn cần

- Windows 10 (22H2) hoặc 11, hoặc macOS 13 trở lên (Apple Silicon hoặc Intel).
- Google Chrome bản ổn định, đã đăng nhập Facebook, và là thành viên các group bạn muốn theo dõi.
- Quyền cài ứng dụng cho tài khoản của bạn (không cần quyền quản trị cho tiện ích).

## Bước 1. Cài ứng dụng

**Windows**
1. Tải tệp `DealSonar-…-x86_64-pc-windows-msvc.exe` từ trang tải về: _[liên kết sẽ có khi phát hành]_.
2. Mở tệp. Nếu Windows hiện "Nhà phát hành: tên công ty", chọn **Cài đặt**. Nếu hiện "Windows protected your PC" kèm *Unknown publisher*, đây là bản **chưa ký**, không phải bản khách hàng: dừng lại và báo người phát hành.
3. Hoàn tất trình cài đặt, mở DealSonar.

**macOS**
1. Tải `.dmg` đúng máy: `aarch64-apple-darwin` cho Apple Silicon (máy từ cuối 2020 có chip M), `x86_64-apple-darwin` cho Intel. Nếu không chắc: menu Apple → *Giới thiệu về máy Mac*.
2. Mở `.dmg`, kéo **DealSonar** vào *Applications*, rồi mở từ *Applications*.
3. Bản khách hàng đã được Apple notarize nên mở thẳng. Nếu macOS báo không xác minh được nhà phát triển, đây là bản chưa notarize: dừng lại và báo người phát hành.

## Bước 2. Cài tiện ích Chrome

1. Mở liên kết cửa hàng Chrome: _[liên kết sẽ có khi phát hành]_.
2. Chọn **Thêm vào Chrome** → **Thêm tiện ích**.
3. Ghim biểu tượng DealSonar lên thanh công cụ (biểu tượng mảnh ghép → ghim).

Không cần bật chế độ nhà phát triển.

## Bước 3. Ghép nối

1. Mở ứng dụng DealSonar. Ở màn hình chào, đồng ý điều khoản quyền riêng tư.
2. Ở **Bước 1: Kết nối Chrome Extension**, bấm **Kiểm tra lại**. Ứng dụng tự khai báo cho Chrome biết tiện ích nào được phép nói chuyện với nó.
3. Mở Chrome, bấm biểu tượng DealSonar để mở bảng bên cạnh. Trạng thái phải là **Đã kết nối**. Nếu hiện **Mất kết nối**, bấm **Kiểm tra lại** trong ứng dụng rồi bấm **Thử lại** trong bảng bên cạnh.

Giữ ứng dụng DealSonar đang chạy khi muốn quét.

## Nếu không ghép nối được

| Triệu chứng | Cách xử lý |
|---|---|
| Bảng bên cạnh báo **Mất kết nối** | Chắc chắn ứng dụng DealSonar đang chạy; bấm **Kiểm tra lại** trong ứng dụng, rồi **Thử lại** trong bảng; đóng hẳn Chrome (tất cả cửa sổ) rồi mở lại |
| Bạn dùng Edge hoặc Brave | Chưa được cam kết hỗ trợ. Dùng Google Chrome |
| Vừa cập nhật hoặc di chuyển ứng dụng | Mở ứng dụng một lần, bấm **Kiểm tra lại** |
| Ứng dụng báo đã cài cấu hình nhưng tiện ích vẫn không nối | Vào `chrome://extensions`, bật *Chi tiết* của DealSonar, chụp màn hình dòng **ID** (32 chữ cái) và gửi cho bên hỗ trợ |

## Cập nhật lên bản mới

Tải bộ cài mới nhất và cài đè lên bản đang dùng (Windows: chạy bộ cài; macOS: kéo DealSonar đè vào *Applications* sau khi thoát ứng dụng). Radar, tin và cài đặt của bạn được giữ nguyên. Chrome tự cập nhật tiện ích; thường hai bên không cập nhật cùng lúc nên có thể thấy một thông báo **Cần cập nhật Chrome hoặc ứng dụng** trong ứng dụng, hoặc khung hướng dẫn trong tiện ích. Làm theo hướng dẫn đó (cập nhật bên còn cũ rồi bấm **Kiểm tra lại**); không cần xoá dữ liệu hay ghép nối lại từ đầu. Chi tiết: [05-upgrade-and-recovery.md](05-upgrade-and-recovery.md).

## Gỡ cài đặt

Windows: *Cài đặt → Ứng dụng → DealSonar → Gỡ cài đặt*. macOS: kéo DealSonar ra khỏi *Applications*. Gỡ tiện ích: `chrome://extensions` → *Xóa*.

---

## Dành cho người thử nội bộ

Chỉ dùng khi chủ dự án giao bạn bản thử nội bộ (release đánh dấu **prerelease**, "bản thử nội bộ").

1. Cài ứng dụng như Bước 1. Cảnh báo chưa ký là bình thường ở bản này; ghi lại cảnh báo bạn thấy (tên, ảnh chụp).
2. Giải nén `DealSonar-extension-<tag>-internal-unpacked.zip` vào một thư mục cố định. Mở `chrome://extensions`, bật **Chế độ dành cho nhà phát triển**, chọn **Tải tiện ích đã giải nén** và chọn thư mục đó. Đừng chọn tệp `-webstore.zip`: gói đó không có khoá định danh và sẽ nhận ID khác.
3. ID hiển thị trên thẻ tiện ích phải là `hkmjpcenjjebhpjicnbpmogidfcbmbjn`. Nếu khác, báo ngay vì ứng dụng sẽ không nhận ra.
4. Ghép nối như Bước 3.
5. Ghi kết quả (hệ điều hành và phiên bản, phiên bản Chrome, SHA-256 bộ cài từ `SHA256SUMS.txt`, ID tiện ích, ghép nối được hay không, ảnh chụp) theo quy định ở [04-distribution.md mục 6](04-distribution.md#6-bằng-chứng-chạy-thật). Dùng mã người thử, không ghi tên hay email.
