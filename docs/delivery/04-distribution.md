# Phân phối Desktop và extension cho khách hàng

Trạng thái: **đề xuất kỹ thuật, chờ chủ dự án xác nhận** · gắn với issue #7

Tệp máy đọc được: [`distribution.json`](distribution.json) (nền tảng cam kết, trạng thái Chrome Web Store, `decision.status`). Sổ bằng chứng chạy thật: [`distribution-evidence.json`](distribution-evidence.json). Hướng dẫn cho khách: [`customer-install-guide.md`](customer-install-guide.md).

## 1. Hai loại bản phát hành, không được nhầm

| | **Bản thử nội bộ** | **Bản khách hàng** |
|---|---|---|
| Bộ cài Desktop | Có thể chưa ký (Windows) hoặc chỉ ký ad-hoc (macOS) | Windows: chữ ký Authenticode hợp lệ. macOS: Developer ID và notarization |
| Extension | ZIP *Load unpacked* (có `key`, ID cố định) | Cài từ Chrome Web Store (không cần bật Developer mode) |
| Đăng trên GitHub | **Prerelease**, tiêu đề ghi "(bản thử nội bộ)", ghi lý do ở đầu ghi chú | Release thường |
| Ai được gửi | Người thử, đội nội bộ | Khách hàng |

Workflow `release.yml` tự phân loại bằng `scripts/release-manifest.mjs`. Một tag là **bản khách hàng** chỉ khi đồng thời đúng cả bốn điều kiện: tag không có hậu tố prerelease; chủ dự án đã đặt `decision.status = "confirmed"`; mọi nền tảng `committed` có bộ cài mà hệ điều hành xác nhận đã ký (và notarize trên macOS) ngay trên máy build; extension ở trạng thái `published` trên Chrome Web Store đúng phiên bản. Thiếu một điều kiện là bản nội bộ, và `release-manifest.json` đính kèm liệt kê từng lý do chặn.

Hiện tại `decision.status = "proposed"` và Web Store là `not_published`, nên **mọi bản dựng hôm nay đều là bản thử nội bộ**. Đó là hành vi đúng, không phải lỗi.

## 2. Hệ điều hành và kênh đề xuất

| Nền tảng | Cam kết cho khách | Bộ cài | Cần để đạt "bản khách hàng" |
|---|---|---|---|
| Windows 10 22H2 / 11, x64 | Có | NSIS `.exe` | Chữ ký Authenticode |
| macOS 13+ Apple Silicon | Có | `.dmg` | Developer ID + notarization |
| macOS 13+ Intel | Có | `.dmg` | Developer ID + notarization |
| Linux x64 (`.deb`, AppImage) | **Không** | `.deb`, `.AppImage` | Chỉ dùng nội bộ, không ký, không có bằng chứng |

Trình duyệt cam kết: **Google Chrome** (bản ổn định, từ 116, theo `minimum_chrome_version`). Edge và Brave được ghi file khai báo native host nhưng chưa có bằng chứng chạy thật, nên **không cam kết**.

Kênh: bộ cài Desktop tải từ trang GitHub Releases của dự án; extension cài từ **Chrome Web Store với chế độ "Unlisted"** (cài qua liên kết, không hiện trong tìm kiếm). Lý do: trên Windows và macOS Chrome chặn cài extension ngoài cửa hàng với người dùng thường, và *Load unpacked* đòi bật Developer mode, không phù hợp khách không rành kỹ thuật (rủi ro R-2 trong [03-risks-compliance.md](03-risks-compliance.md)). "Unlisted" cho phép kiểm soát ai biết liên kết mà vẫn cài một chạm. Nếu chủ dự án muốn "Public" hoặc kênh khác (trang web riêng, MSI cho doanh nghiệp), sửa `distribution.json` và các điều kiện ở trên vẫn áp dụng.

Đây là đề xuất của kỹ thuật. Chủ dự án xác nhận bằng cách đặt `decision.status = "confirmed"`, điền `decided_by`, `decided_on`.

## 3. Việc chỉ chủ dự án làm được

Mã nguồn không thể tự có các thứ dưới đây. Mỗi mục là điều kiện chặn, kèm chỗ cấu hình trong repo.

| # | Việc | Ai/Ở đâu | Cấu hình trong repo |
|---|---|---|---|
| O-1 | Xác nhận danh sách nền tảng và kênh ở mục 2 | Chủ dự án | `distribution.json` → `decision` |
| O-2 | Đăng ký tài khoản nhà phát triển **Chrome Web Store** (phí đăng ký một lần), bật xác minh 2 bước, khai báo nhà phát hành | Chủ dự án, Chrome Web Store Developer Dashboard | — |
| O-3 | Tạo mục extension, tải ZIP `DealSonar-extension-<tag>-webstore.zip`, điền: mục đích duy nhất, lý do từng quyền (`nativeMessaging`, `tabs`, `scripting`, `storage`, `alarms`, `idle`, `sidePanel`, host `facebook.com/groups/*`), công bố dữ liệu người dùng, **URL chính sách quyền riêng tư**, rồi gửi duyệt với chế độ Unlisted | Chủ dự án (có thể cần tư vấn pháp lý, xem R-2/R-6) | — |
| O-4 | Sau khi có mục trên Web Store: lấy **ID mục** (32 chữ a–p) và **khoá công khai** ở tab *Package → View public key*. Gửi hai giá trị cho kỹ thuật | Chủ dự án | Kỹ thuật cập nhật `manifest.json` `key`, `DEFAULT_CHROME_EXTENSION_ID` / `KNOWN_CHROME_EXTENSION_IDS` và `distribution.json` `web_store.item_id`; `node scripts/extension-identity.mjs` phải xanh |
| O-5 | **Windows**: mua chứng thư ký mã (OV hoặc EV). Từ 2023-06-01 khoá riêng nằm trong HSM hoặc token, **không xuất được PFX**: dùng dịch vụ ký đám mây (ví dụ Azure Artifact Signing) hoặc HSM của nhà cung cấp | Chủ dự án (xác minh danh tính doanh nghiệp, thường nhiều ngày) | Biến kho `WINDOWS_SIGN_COMMAND` (lệnh CLI của nhà cung cấp, có `"%1"`); hoặc secret `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` nếu chứng thư còn xuất được PFX |
| O-6 | **macOS**: tham gia Apple Developer Program, tạo chứng thư *Developer ID Application*, tạo mật khẩu riêng cho ứng dụng (hoặc khoá API) để notarize | Chủ dự án, Apple Developer | Secret `APPLE_CERTIFICATE` (p12 base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| O-7 | Quyền phát hành: người có quyền đẩy tag `v*` và quản lý secret/biến của repo; chọn người duyệt cho bản khách hàng | Chủ repo | Cài đặt repo GitHub |
| O-8 | Tìm người thử trên máy sạch (VM mới hoặc máy chưa từng cài DealSonar) và để họ làm theo [hướng dẫn khách hàng](customer-install-guide.md) | Chủ dự án | Ghi kết quả vào `distribution-evidence.json` |

Khi các secret ở O-5/O-6 có mặt, workflow **bắt buộc ký thành công** (`--require-signing`): nếu chứng thư sai hoặc notarize lỗi thì job build đỏ thay vì âm thầm xuất bản bộ cài chưa ký.

## 4. Định danh ổn định giữa Desktop và extension

Khách không phải gõ ID. App Desktop ghi file khai báo native messaging với `allowed_origins` gồm mọi ID trong `KNOWN_CHROME_EXTENSION_IDS` (`crates/core/src/service/mod.rs`). Hiện có một ID, suy ra từ `key` trong `apps/extension/public/manifest.json`: `hkmjpcenjjebhpjicnbpmogidfcbmbjn`.

Lưu ý quan trọng về Web Store: Web Store **cấp ID riêng cho mục** và yêu cầu tải lên manifest **không có** `key`. Vì vậy ID của bản cài từ cửa hàng sẽ khác ID suy ra từ `key` hiện tại, cho đến khi bước O-4 đưa khoá công khai do cửa hàng cấp vào `manifest.json`. Bản ZIP nội bộ giữ `key`, bản `-webstore.zip` bỏ `key` (`scripts/package-extension.mjs`). `scripts/extension-identity.mjs` (chạy trong CI và trong `validate` của release) từ chối mọi lệch giữa `key`, hằng số Rust và `distribution.json`.

**Windows**: Chrome chỉ tìm host qua khoá registry `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dealsonar.host` (Edge và Brave có khoá tương ứng). Trước thay đổi này app chỉ ghi file JSON và không ghi registry, nên ghép nối trên Windows sạch không thể thành công. Giờ `register_native_host_windows` ghi khoá khi bấm *Kiểm tra lại* và mỗi lần khởi động. **Phần này mới được kiểm tra biên dịch cho `x86_64-pc-windows-msvc` và kiểm thử đơn vị cho tham số lệnh; chưa chạy trên máy Windows thật.** Cần bằng chứng ở mục 6.

## 5. Quy trình phát hành

1. `git tag vX.Y.Z && git push origin vX.Y.Z` (tag có `-` là prerelease, luôn là bản nội bộ).
2. Job `validate`: SemVer, định danh extension, kiểm thử script phân phối, sổ bằng chứng hợp lệ.
3. Job `ci`, rồi `extension` (hai ZIP: `-internal-unpacked.zip` có `key`, `-webstore.zip` không có) và `desktop` (4 mục tiêu). Mỗi bộ cài được `release-provenance.mjs` kiểm: SHA-256, phiên bản, hệ điều hành, chữ ký hợp lệ theo `codesign`/`spctl` (macOS) hoặc `Get-AuthenticodeSignature` (Windows). Chữ ký ad-hoc **không** tính là đã ký.
4. Job `publish`: `release-manifest.mjs` quyết định kênh, viết `release-manifest.json` và ghi chú, rồi tạo (hoặc cập nhật khi chạy lại) release. Bản không đủ điều kiện luôn là prerelease.
5. Tải lên Web Store là **thao tác tay** của chủ dự án (O-3) vì mỗi lần gửi duyệt cần khai báo và thời gian duyệt; sau khi được duyệt, cập nhật `web_store.status = "published"` và `published_version`.

## 6. Bằng chứng chạy thật

`release-manifest.json` chỉ chứng minh điều xảy ra lúc build. Việc "người thử cài và ghép nối được trên máy sạch" cần quan sát thật, ghi vào [`distribution-evidence.json`](distribution-evidence.json) bằng `node scripts/distribution-evidence.mjs add entry.json`. Mỗi mục ghi: nền tảng, tag, SHA-256 bộ cài đã chạy, bản hệ điều hành, trình duyệt và phiên bản, nguồn extension, ID extension hiển thị trong `chrome://extensions`, máy có sạch không, kết quả ghép nối, cảnh báo chữ ký quan sát được, mã người thử (không dùng tên hay email), nơi lưu ảnh/log.

Quy tắc, được kiểm bằng `scripts/distribution-evidence.mjs`:

- Nền tảng chỉ là `customer_ready` khi có mục `customer_download`: máy sạch, tải từ URL https công khai, bản không phải prerelease, extension từ Web Store, ghép nối thành công, và (với nền tảng cần chữ ký) chữ ký hợp lệ.
- Mục `internal_trial` (ZIP *Load unpacked*, bản chưa ký) được ghi nhận nhưng **không bao giờ** tính là sẵn sàng cho khách.
- Chạy `node scripts/distribution-evidence.mjs --require-customer` trước khi gọi bất kỳ nền tảng nào là đã hỗ trợ.

**Hiện sổ bằng chứng trống: chưa có lần chạy thật nào.** Không nền tảng nào được coi là đã kiểm chứng.

## 7. Còn thiếu để đóng issue #7

| Tiêu chí | Đã làm trong repo | Còn thiếu (cần người/tài khoản thật) |
|---|---|---|
| Chốt OS và kênh, ghi điều kiện tài khoản/chữ ký/quyền | Đề xuất mục 2, bảng việc của chủ dự án mục 3 | O-1 xác nhận |
| Bộ cài và extension có định danh ổn định; cài theo hướng dẫn, ghép nối trên máy sạch | ID cố định có kiểm tra tự động; bỏ nhập ID; sửa registry Windows; hai gói extension; hướng dẫn khách; ký tự động khi có secret | O-2…O-6 (tài khoản, chứng thư); O-8 chạy thử trên máy sạch Windows và macOS |
| Lưu phiên bản/OS/bằng chứng; phân biệt nội bộ và khách | `release-manifest.json`, `*.provenance.json`, sổ bằng chứng có kiểm tra, prerelease tự động | Các mục bằng chứng thật |
