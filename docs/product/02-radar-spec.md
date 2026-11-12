# Đặc tả radar

Trạng thái: nháp v0.1 · 2026-11-11

Radar là đối tượng trung tâm của sản phẩm. Tài liệu này định nghĩa cấu trúc, kiểu trường, vòng đời, và thư viện mẫu. Lược đồ lưu trữ ở [specs/04-data-model.md](../specs/04-data-model.md).

## 1. Bốn phần của một radar

| Phần | Nội dung | Ai tạo |
|---|---|---|
| **Nguồn** | Danh sách group cần theo dõi | Người dùng chọn từ các group extension đã thấy |
| **Mô tả** | Câu văn thường nói thứ cần tìm | Người dùng viết, hoặc lấy từ mẫu |
| **Trường** | Danh sách thông tin cần trích từ mỗi bài | AI đề xuất từ mô tả, người dùng sửa |
| **Kênh báo** | Nơi nhận tin khớp | Người dùng chọn (MVP: Telegram) |

## 2. Định nghĩa radar

```jsonc
{
  "id": "01JCF3...",                    // ULID
  "name": "Khách thuê căn hộ Cầu Giấy",
  "status": "active",                   // draft | active | paused | archived
  "template_id": "bds.khach-thue",      // null nếu tạo từ trang trắng
  "current_version": 3,
  "source_ids": ["01JCF1...", "01JCF2..."],
  "notify": {
    "channel_ids": ["01JCF9..."],
    "mode": "instant",                  // instant | digest (P1)
    "min_score": 0.6,
    "quiet_hours": null                 // P1: {"from": "22:30", "to": "06:30"}
  }
}
```

Phần quyết định cách chấm bài nằm trong **phiên bản radar**, bất biến sau khi tạo:

```jsonc
{
  "radar_id": "01JCF3...",
  "version": 3,
  "description": "Người đang cần thuê căn hộ 2 phòng ngủ ở Cầu Giấy, dưới 15 triệu một tháng",
  "language_hint": "vi",                // gợi ý, không bắt buộc; AI vẫn xử lý ngôn ngữ khác
  "fields": [ /* xem §3 */ ],
  "match_policy": {
    "want_intent": "demand",            // demand | supply | any
    "exclude_roles": ["peer"],          // loại người cùng nghề
    "hard_filters": [                   // điều kiện trên trường đã trích; không đạt thì không báo
      {"field": "price", "op": "lte", "value": 15000000, "when_missing": "pass"}
    ]
  },
  "user_profession": "môi giới bất động sản"  // để AI nhận ra người cùng nghề
}
```

**Vì sao tách phiên bản.** Sửa mô tả hoặc trường làm thay đổi ý nghĩa của kết quả. Mỗi đánh giá và mỗi bộ luật gắn với một phiên bản cụ thể, nên tin cũ không bị diễn giải lại theo định nghĩa mới, và bộ luật cũ tự động hết hiệu lực khi radar đổi.

Thay đổi tạo phiên bản mới: mô tả, danh sách trường (thêm, xoá, đổi kiểu, đổi mô tả trường), `match_policy`, `user_profession`. Thay đổi không tạo phiên bản mới: tên radar, nguồn, kênh báo, ngưỡng điểm.

## 3. Trường

### 3.1 Định nghĩa trường

```jsonc
{
  "key": "price",                       // snake_case, duy nhất trong radar, không đổi sau khi tạo
  "label": "Giá thuê",
  "type": "money",
  "description": "Ngân sách thuê mỗi tháng khách nêu trong bài",
  "required": false,                    // true: thiếu trường này thì hạ điểm khớp
  "options": null,                      // bắt buộc với enum / multi_enum
  "show_in_alert": true,                // có hiện trong tin Telegram không
  "order": 2
}
```

### 3.2 Kiểu trường

| Kiểu | Giá trị chuẩn hoá | Ví dụ thô → chuẩn |
|---|---|---|
| `text` | Chuỗi | "nhà mặt ngõ ô tô đỗ cửa" |
| `number` | Số | "3pn" → `3` |
| `money` | `{amount, currency, period}` | "tầm 12-15tr/th" → `{min: 12000000, max: 15000000, currency: "VND", period: "month"}` |
| `phone` | Chuỗi E.164 | "0912.345.678" → `+84912345678` |
| `location` | `{raw, province, district, ward}` | "khu cầu giấy" → `{raw: "khu cầu giấy", province: "Hà Nội", district: "Cầu Giấy"}` |
| `enum` | Một giá trị trong `options` | "cần thuê" → `rent` |
| `multi_enum` | Mảng giá trị trong `options` | `["điều hoà", "máy giặt"]` |
| `boolean` | `true` / `false` | "chính chủ" → `true` |
| `date` | ISO 8601 | "cuối tháng này" → `2026-11-30` (tính từ ngày đăng) |
| `range` | `{min, max, unit}` | "50-70m2" → `{min: 50, max: 70, unit: "m2"}` |
| `url` | Chuỗi URL | |

`money` luôn cho phép khoảng (`min`/`max`); một con số đơn điền cả hai. Số tiền tiếng Việt viết tắt ("3tr5", "2 tỷ 3", "15 củ") do bộ chuẩn hoá chung xử lý, dùng lại cho cả AI và bộ luật.

### 3.3 Giá trị đã trích

Mỗi trường trong một tin lưu kèm bằng chứng:

```jsonc
{
  "price": {
    "value": {"min": 12000000, "max": 15000000, "currency": "VND", "period": "month"},
    "raw": "tầm 12-15tr/th",
    "confidence": 0.92,
    "source": "ai"                      // ai | rule | user (người dùng sửa tay)
  }
}
```

`raw` phải là đoạn trích nguyên văn từ bài. Nếu `raw` không xuất hiện trong bài, giá trị bị coi là bịa và bị loại. Đây là cách kiểm tra rẻ chống AI tự suy diễn.

### 3.4 Trường hệ thống

Mọi radar đều có, người dùng không xoá được:

| Khoá | Kiểu | Ý nghĩa |
|---|---|---|
| `summary` | text | Tóm tắt một dòng, tối đa 140 ký tự, cùng ngôn ngữ với bài |
| `intent` | enum | `demand` (cần), `supply` (có), `other` |
| `author_role` | enum | `end_user`, `peer`, `unknown` |
| `score` | number | Mức khớp với mô tả, 0–1 |
| `reason` | text | Một câu giải thích vì sao khớp hoặc không |

## 4. Vòng đời

```
            tạo                bật                tạm dừng
  (không) ───────► draft ───────────► active ◄──────────► paused
                     ▲                  │
                     │ sửa định nghĩa    │ lưu trữ
                     └──────────────────┤
                                        ▼
                                    archived
```

- **draft:** đang soạn hoặc đang xem thử. Không gửi thông báo. Xem thử chạy được ở trạng thái này.
- **active:** bài mới của các nguồn được chấm và báo.
- **paused:** bài vẫn được thu (nếu radar khác còn dùng nguồn đó) nhưng không chấm cho radar này. Bật lại thì chấm bù các bài thu trong 24 giờ gần nhất, không gửi thông báo cho phần chấm bù.
- **archived:** ẩn khỏi danh sách; tin cũ vẫn tra cứu được.

Sửa định nghĩa của radar đang chạy: tạo phiên bản mới, tự chạy xem thử trên 50 bài gần nhất, radar tiếp tục dùng phiên bản cũ cho tới khi người dùng xác nhận.

## 5. Xem thử

Mục đích: cho người dùng thấy radar làm gì trên bài thật trước khi nó bắt đầu làm phiền họ, và thu nhãn đầu tiên.

1. Lấy tối đa 50 bài gần nhất trong kho từ các nguồn đã chọn. Nếu dưới 20 bài, yêu cầu extension quét thử ([Giao thức](../specs/01-protocol.md), `crawl.request` với `reason: "preview"`).
2. Chạy toàn bộ chuỗi xử lý ở chế độ không tạo tin và không thông báo.
3. Hiển thị hai cột "Khớp" và "Không khớp", sắp theo điểm. Mỗi bài hiện nội dung gốc, các trường đã trích với đoạn `raw` được tô sáng, và câu `reason`.
4. Người dùng bấm đúng/sai trên từng bài. Mỗi nhãn được lưu thành phản hồi và dùng làm ví dụ ngay ở lần chạy lại.
5. Nút "Chạy lại" sau khi sửa mô tả hoặc trường.

Cảnh báo cần hiện trong màn xem thử:

- Không bài nào khớp trong 50 bài: gợi ý nới mô tả hoặc đổi nguồn.
- Trên 60% bài khớp: mô tả quá rộng, sẽ gây nhiều thông báo.
- Một trường bắt buộc trống ở trên 70% bài khớp: gợi ý bỏ bắt buộc.

## 6. Phản hồi

| Lý do | Hệ quả ngay | Hệ quả khi học |
|---|---|---|
| Đúng | Không | Ví dụ dương |
| Không liên quan | Ẩn tin | Ví dụ âm |
| Trích sai trường | Mở form sửa giá trị | Ví dụ kèm giá trị đúng |
| Người cùng nghề | Ẩn tin; hỏi có chặn tác giả không | Ví dụ âm kèm `author_role: peer` |
| Trùng | Gộp vào tin gốc người dùng chỉ ra | Điều chỉnh ngưỡng trùng |
| Rác | Ẩn tin | Ví dụ âm |

Cách phản hồi đi vào hệ thống:

- **Ngay lập tức:** tối đa 8 phản hồi gần nhất (cân bằng dương/âm) được đưa vào prompt chấm bài làm ví dụ.
- **Định kỳ (P1):** toàn bộ phản hồi là dữ liệu chuẩn để sinh và kiểm định bộ luật.

## 7. Thư viện mẫu

Mẫu là file JSON đi kèm app (`apps/desktop/templates/*.json`), không nằm trong cơ sở dữ liệu. Chọn mẫu là sao chép nội dung vào một radar nháp; sau đó radar độc lập với mẫu.

```jsonc
{
  "id": "bds.khach-thue",
  "industry": "Bất động sản",
  "name": "Khách cần thuê theo khu vực và tầm giá",
  "description_template": "Người đang cần thuê {loại nhà} ở {khu vực}, ngân sách {tầm giá}",
  "placeholders": [
    {"key": "loại nhà", "hint": "căn hộ 2 phòng ngủ, nhà nguyên căn…"},
    {"key": "khu vực", "hint": "Cầu Giấy, Thủ Đức…"},
    {"key": "tầm giá", "hint": "dưới 15 triệu"}
  ],
  "user_profession": "môi giới bất động sản",
  "fields": [ /* định nghĩa trường như §3.1 */ ],
  "match_policy": {"want_intent": "demand", "exclude_roles": ["peer"]},
  "seed_ruleset": "bds-vi-v1"           // tuỳ chọn: bộ luật có sẵn làm tầng lọc rẻ
}
```

### Danh mục khởi đầu

| Ngành | Mẫu | Trường chính | Ý định |
|---|---|---|---|
| Bất động sản | Khách cần thuê/mua theo khu vực và tầm giá | loại giao dịch, loại nhà, khu vực, giá, diện tích, số phòng ngủ, SĐT | demand |
| Bất động sản | Tin chính chủ | loại giao dịch, khu vực, giá, diện tích, chính chủ, SĐT | supply |
| Dịch vụ nhà cửa | Bài hỏi "ai biết thợ…" | loại việc, khu vực, mức gấp, SĐT | demand |
| Xe và đồ cũ | Tin bán dưới giá thị trường | hãng, dòng, đời, giá, số km, khu vực, SĐT | supply |
| Tuyển dụng | Người tìm việc | vị trí, kinh nghiệm, khu vực, mức lương mong muốn | supply |
| Vận tải, ghép hàng | Cần xe / có xe trống | loại tin, điểm đi, điểm đến, ngày, tải trọng, loại hàng, SĐT | any |
| Order, bán hàng | Bài hỏi mua một loại sản phẩm | sản phẩm, số lượng, ngân sách, khu vực | demand |

Mẫu BĐS là mẫu duy nhất có `seed_ruleset` trong MVP, lấy từ bộ luật bất động sản tiếng Việt đã có.

## 8. Giới hạn theo gói

| Giới hạn | Cá nhân | Chuyên nghiệp |
|---|---|---|
| Radar đang chạy | 2 | Không giới hạn |
| Group được theo dõi (tổng) | 10 | 50 |
| Trường mỗi radar | 12 | 20 |

Giới hạn trường tồn tại vì mỗi trường làm dài prompt và giảm độ chính xác trích xuất; con số cần kiểm lại khi đo.
