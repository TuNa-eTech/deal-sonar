# Cập nhật tại chỗ và khôi phục kết nối Chrome

Trạng thái: **cơ chế và kiểm thử tự động đã có; chưa có bằng chứng nâng cấp trên máy Windows/macOS thật** · gắn với issue #8, phụ thuộc [04-distribution.md](04-distribution.md)

## 1. Đường cập nhật dành cho khách

Không có bộ tự cập nhật trong app (`createUpdaterArtifacts: false`). Đường cập nhật là **cài đè**:

| Thành phần | Cách khách cập nhật | Lưu ý |
|---|---|---|
| Ứng dụng Desktop (Windows) | Tải bộ cài `.exe` mới ở trang Releases, chạy lên bản đang cài | Bộ cài NSIS thay file trong thư mục cài |
| Ứng dụng Desktop (macOS) | Tải `.dmg` mới, kéo DealSonar đè vào *Applications* | Thoát ứng dụng trước khi đè |
| Tiện ích Chrome (từ Web Store) | Chrome tự cập nhật theo lịch của Chrome, khách có thể ép ở `chrome://extensions` → Cập nhật | **Không đồng bộ với việc cập nhật Desktop**: hai bên thường lệch bản trong một khoảng thời gian |
| Tiện ích Chrome (ZIP *Load unpacked*, chỉ bản thử nội bộ) | Giải nén bản mới đè thư mục cũ rồi bấm Reload ở thẻ tiện ích | Không tự cập nhật |

## 2. Dữ liệu nằm ở đâu, nên nâng cấp không đụng tới

| Dữ liệu | Vị trí | Bộ cài có ghi đè không |
|---|---|---|
| Radar, tin, bài, cài đặt (SQLite) và thư mục `backups/` | macOS `~/Library/Application Support/DealSonar`, Windows `%APPDATA%\DealSonar`, Linux `~/.local/share/dealsonar` (hoặc `DEALSONAR_DATA_DIR`) | Không: nằm ngoài thư mục cài |
| File khai báo native host | macOS/Linux: thư mục `NativeMessagingHosts` của trình duyệt. Windows: `%APPDATA%\DealSonar\com.dealsonar.host.json` cộng khoá registry HKCU | Không, nhưng đường dẫn tới `dealsonar-native-host` có thể cũ sau khi cài đè hoặc di chuyển |
| Hàng đợi gửi và bài đã thấy của tiện ích | Bộ nhớ của hồ sơ Chrome | Không, thuộc Chrome |

Khi mở bản mới, `Store::open` áp các migration còn thiếu **sau khi chụp bản sao** vào `backups/dealsonar-pre-vNNNN-<thời gian>.db` (giữ 5 bản gần nhất). Bản mới thấy CSDL của bản **tương lai** thì từ chối mở và báo cần cập nhật, không sửa gì (`NewerSchemaVersion`), nên hạ cấp không làm hỏng dữ liệu. Khi khởi động, `refresh_native_host_manifest_if_paired` ghi lại file khai báo (và khoá registry trên Windows) nếu đường dẫn tới relay đã đổi, giữ nguyên ID tiện ích đã ghép.

## 3. Hợp đồng tương thích Chrome ⇄ Desktop

Hai tầng (xem [01-protocol.md §3](../specs/01-protocol.md#3-bắt-tay-và-phiên-bản)):

1. **Số giao thức** `PROTOCOL_VERSION` (hiện là 2): khác số thì bên nhận trả `protocol_mismatch`, không xử lý gì thêm.
2. **Phiên bản phát hành tối thiểu** của bên kia: Desktop yêu cầu tiện ích từ `MIN_EXTENSION_VERSION` (`crates/protocol/src/compat.rs`); tiện ích yêu cầu Desktop từ `MIN_DESKTOP_VERSION` (`apps/extension/src/compat.ts`). Hai hằng này chỉ nâng khi có thay đổi hành vi mà số giao thức không biểu diễn được. Phiên bản không đọc được (bản dev) không bao giờ bị coi là cũ.

Desktop báo phiên bản của mình trong `hello.ok` là **tag phát hành** (biến `DEALSONAR_VERSION` do workflow đặt), không phải phiên bản crate.

| Tình huống | Desktop thấy | Tiện ích thấy | Dữ liệu | Cách phục hồi |
|---|---|---|---|---|
| Chrome tự cập nhật lên bản dùng giao thức mới, Desktop chưa | Banner đỏ "Cần cập nhật Chrome hoặc ứng dụng" kèm lý do và hướng dẫn, dòng cảnh báo ở màn Sức khoẻ | "Mất kết nối" và hướng dẫn cập nhật Desktop | Giữ nguyên | Cài đè bản Desktop mới, mở app, bấm **Kiểm tra lại**, bấm **Thử lại** ở tiện ích. Cảnh báo tự mất khi bắt tay thành công |
| Desktop mới, tiện ích cũ hơn mức tối thiểu | Banner vàng, vẫn nhận bài | (không biết) | Giữ nguyên | `chrome://extensions` → Cập nhật |
| Desktop cũ hơn mức tối thiểu của tiện ích | (không biết) | Vẫn "Đã kết nối" kèm khung hướng dẫn cài đè Desktop | Giữ nguyên | Cài đè Desktop |
| Sau cài đè, đường dẫn relay đổi | Khởi động tự ghi lại khai báo; nếu Chrome đang mở, đóng hẳn rồi mở lại Chrome | "Mất kết nối" tới khi relay chạy lại | Giữ nguyên | **Kiểm tra lại** trong app |
| Hai bên đúng bản nhưng ghép nối hỏng | "Chờ Chrome" | Mất kết nối, hiện ID tiện ích | Giữ nguyên | Hướng dẫn ở [customer-install-guide.md](customer-install-guide.md) |

Không tình huống nào đòi xoá dữ liệu hay ghép nối lại từ đầu.

## 4. Đã kiểm tra tự động, và chưa kiểm tra

Tự động (chạy trong `cargo test --workspace` trên Linux, Windows, macOS Apple Silicon và Intel ở CI, và `pnpm ext:test`, `pnpm ui:test`, `pnpm dist:verify`):

- `crates/core/tests/upgrade_continuity.rs`: dựng CSDL đúng như schema cũ nhất (migration 0001) có nguồn, radar đang chạy, bài và tin; mở bằng bản hiện tại; kiểm có bản sao trước migration, radar và tin cũ đọc được, file khai báo native host bị cũ được sửa mà giữ origin, một bài mới được thu, đánh giá và kích hoạt thông báo. Vòng lặp trên `crates/store/tests/fixtures/releases/*.sqlite3` sẽ kiểm mọi bản phát hành thật khi được thêm vào (hiện thư mục trống).
- `crates/core/tests/version_skew.rs`: kết nối thật qua IPC cục bộ; số giao thức lạ bị từ chối, được hiển thị thành hướng dẫn tiếng Việt, mất khi bắt tay thành công; tiện ích cũ hơn mức tối thiểu được phục vụ nhưng bị gắn cờ.
- `apps/extension/tests/version-skew-background.test.ts`, `compat.test.ts`: tiện ích ghi nhận lệch bản, hiển thị hướng dẫn, xoá cờ khi bắt tay lại và **không động tới dữ liệu cục bộ**.
- `apps/desktop/ui/src/test/version-skew.test.tsx`: banner và trạng thái vận hành.
- `scripts/compat-constants.test.mjs`: các hằng tương thích và số giao thức hai phía không lệch nhau.

**Chưa kiểm tra** (cần máy thật, xem mục 5): cài đè bằng NSIS/DMG thật, thư mục dữ liệu sau cài đè trên từng hệ điều hành, tiện ích Chrome Web Store tự cập nhật lệch bản với Desktop thật, thông báo OS/Telegram sau nâng cấp ngoài máy phát triển. Các kiểm thử trên mô phỏng nâng cấp ở tầng dữ liệu và giao thức, không thay cho chúng.

## 5. Quy trình chạy thật trên từng hệ điều hành cam kết

Làm trên máy sạch hoặc VM, cho từng nền tảng `committed` trong `distribution.json`, dùng **bản khách hàng trước** rồi **bản khách hàng sau** (cả hai tải từ trang Releases công khai, tiện ích từ Web Store). Dữ liệu và bài chỉ để thử, không dùng tài khoản Facebook thật nếu không cần.

1. Cài bản trước (Desktop + tiện ích), ghép nối, tạo một Radar và có ít nhất một tin (ghi SHA-256 bộ cài).
2. Cài đè bản sau bằng đường ở mục 1 (ghi SHA-256). Mở app.
3. Radar còn đó, tin cũ mở được.
4. Thu một bài mới (**Quét ngay** hoặc nhóm thử), xác nhận tin mới xuất hiện và thông báo (OS hoặc Telegram) đến nơi.
5. **Lệch bản A** (Chrome mới hơn Desktop): để Desktop ở bản trước, cập nhật tiện ích. Nếu có lệch, ghi hướng dẫn nhìn thấy ở cả hai phía, cập nhật Desktop, làm theo hướng dẫn, ghi dữ liệu còn nguyên và kết nối trở lại.
6. **Lệch bản B** (Desktop mới hơn Chrome): cập nhật Desktop, giữ tiện ích bản trước (tắt tự cập nhật hoặc dùng bản ZIP cũ), làm tương tự.
7. Ghi kết quả vào `upgrade_runs` của [distribution-evidence.json](distribution-evidence.json). Một nền tảng chỉ `upgrade_verified` khi lần chạy thuộc kênh `customer_download`, cả bốn kiểm tra đều đạt và cả hai kịch bản lệch đều có hướng dẫn, giữ dữ liệu và phục hồi được. `node scripts/distribution-evidence.mjs --require-customer` kiểm điều này.

Nếu hai bản phát hành liên tiếp dùng cùng số giao thức và cùng mức tối thiểu thì kịch bản A/B có thể không sinh hướng dẫn nào: khi đó ghi `guidance_shown: false` kèm `data_kept: true`, `recovered: true`, và cần lần chạy với bản cố ý lệch (hoặc bản thử nội bộ) để thấy hướng dẫn thật. Ghi rõ trong `evidence_ref`.

## 6. Quy tắc cho người phát hành

- Đổi số giao thức, hoặc đổi hành vi mà bản cũ của bên kia xử lý sai: nâng `PROTOCOL_VERSION` (cả hai phía) hoặc `MIN_*_VERSION` tương ứng, rồi cập nhật bảng ở mục 3.
- Thêm migration: giữ migration chỉ tiến; không sửa migration đã phát hành.
- Mỗi lần phát hành khách hàng: thêm `vX.Y.Z.sqlite3` theo `crates/store/tests/fixtures/releases/README.md` (dữ liệu giả).
