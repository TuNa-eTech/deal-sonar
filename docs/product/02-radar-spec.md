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
    "quiet_hours": null,                // P1: {"from": "22:30", "to": "06:30"}
    "lead_ttl_hours": 72                // tin còn giá trị bao lâu kể từ lúc đăng; bỏ trống = không hạn
  }
}
```

**Hạn sống của tin (`lead_ttl_hours`).** Mỗi ngành có nhịp riêng: tin bán xe giá tốt mất giá trị sau vài giờ, tin tìm việc thì vài tuần. Hạn tính từ lúc bài được đăng (`post.created_at`); nếu không biết lúc đăng thì tính từ lúc thấy bài. Tin quá hạn vẫn được lưu và vẫn hiện trong app (hàng "Quá hạn"), nhưng **không gửi thông báo**. Lý do: nếu extension quét muộn, một tin đã quá hạn mà vẫn báo thì người dùng chỉ mất công liên hệ. Hàng "Mới" chỉ gồm tin còn hạn. Đổi hạn không tạo phiên bản mới. Giá trị nằm trong JSON `notify` của radar nên không cần migration.

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
    ],
    "condition": {                      // tuỳ chọn: nhánh thay thế và ngoại lệ, AND với hard_filters
      "all": [
        {"any": [
          {"field": "district", "op": "eq", "value": "Cầu Giấy", "when_missing": "fail"},
          {"field": "district", "op": "eq", "value": "Đống Đa",  "when_missing": "fail"}
        ]},
        {"not": {"field": "note", "op": "contains", "value": "ở ghép", "when_missing": "fail"}}
      ]
    }
  },
  "user_profession": "môi giới bất động sản"  // để AI nhận ra người cùng nghề
}
```

**Nhóm điều kiện và ngoại lệ.** `condition` là một biểu thức: `{"all": [...]}` (tất cả), `{"any": [...]}` (ít nhất một), `{"not": {...}}` (ngoại lệ) hoặc một điều kiện đơn giống phần tử của `hard_filters`. Bài đạt khi đạt mọi điều kiện trong `hard_filters` và đạt `condition`. Radar cũ không có `condition` nên cho kết quả đúng như danh sách AND trước đây. `when_missing` quyết định kết quả của chính điều kiện đơn đó khi bài thiếu trường (`pass` = đạt, `fail` = không đạt), tính trước khi `not` đảo ngược. Muốn loại bài có `note` chứa "ở ghép" mà vẫn giữ bài không có `note`, đặt `when_missing: "fail"` cho điều kiện bên trong `not`. Khi lưu hoặc xem thử, hệ thống từ chối trường không có trong `fields`, nhóm rỗng, giá trị sai dạng, lồng quá 8 cấp hoặc quá 64 nút, và báo đường dẫn cụ thể (ví dụ `condition.any[1].not`). Xem thử và xử lý bài mới dùng chung một hàm đánh giá.

**Vì sao tách phiên bản.** Sửa mô tả hoặc trường làm thay đổi ý nghĩa của kết quả. Mỗi đánh giá và mỗi bộ luật gắn với một phiên bản cụ thể, nên tin cũ không bị diễn giải lại theo định nghĩa mới, và bộ luật cũ tự động hết hiệu lực khi radar đổi.

Thay đổi tạo phiên bản mới: mô tả, danh sách trường (thêm, xoá, đổi kiểu, đổi mô tả trường), `match_policy`, `user_profession`. Thay đổi không tạo phiên bản mới: tên radar, nguồn, kênh báo, ngưỡng điểm, hạn sống của tin.

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

### Biến thể

Chủ xe muốn giữ bộ trường đang dùng nhưng đổi tuyến, nhóm nguồn hoặc kênh nhận tin thì **tạo biến thể** từ radar hiện có (thao tác "Tạo biến thể" trên danh sách radar).

1. App đề xuất một bản sao từ phiên bản đang chạy của radar gốc: tên (thêm "(biến thể)"), mô tả, trường, `match_policy`, `user_profession`, nguồn và cấu hình `notify`. Phiên bản ứng viên chưa xác nhận không được sao chép.
2. Người dùng xem và chỉnh bản sao (tên, mô tả, nhóm nguồn, kênh báo, chế độ báo, hạn sống, ngưỡng điểm) rồi mới lưu. Bấm huỷ thì không ghi gì.
3. Biến thể là **radar độc lập**: có ID riêng, `current_version = 1` với phiên bản riêng, và luôn bắt đầu ở `draft` nên chưa chấm bài và chưa gửi thông báo. Muốn chạy phải xem thử và bật như radar mới. Biến thể ghi `variant_of` = ID radar gốc, chỉ để hiển thị nguồn gốc; không có quan hệ nào khác.
4. Tin cũ, lịch sử chấm (`evaluations`) và nhãn phản hồi vẫn gắn với radar gốc và phiên bản của nó; biến thể bắt đầu với lịch sử trống. Vì vậy ví dụ phản hồi của radar gốc không lọt vào prompt của biến thể.
5. Bật, sửa, tạm dừng và lưu trữ biến thể không ảnh hưởng radar gốc, và ngược lại. Lưu trữ radar gốc không làm biến thể mất liên kết dữ liệu.
6. Giới hạn gói tính như radar tạo mới (§8): số trường kiểm khi lưu bản sao, số radar đang chạy kiểm khi bật, số group được theo dõi kiểm khi chọn nguồn.

Danh sách chặn riêng của radar gốc (`blocklist.radar_id`) không được sao chép; chặn áp dụng cho mọi radar vẫn có hiệu lực.

### So sánh hai định nghĩa

Khi đổi tiêu chí, khách cần thấy bài nào xuất hiện hoặc biến mất. Thao tác "So sánh" chấm **một tập bài chung** bằng hai phiên bản radar (cùng radar khác phiên bản, biến thể với radar gốc, hoặc hai radar khác hẳn nhau như "tìm xe" và "tìm hàng" trên cùng một group).

- **Đầu vào:** hai định nghĩa (radar + số phiên bản, mặc định phiên bản đang dùng) và tập bài: các group đã chọn (tối đa 50 bài gần nhất) hoặc danh sách bài cụ thể. Không chọn thì dùng các group hai radar cùng theo dõi.
- **Bản ghi:** mỗi lần so sánh lưu ID phiên bản và nội dung định nghĩa hai bên, danh sách ID bài đã dùng, các group, và kết quả từng bài. Nội dung bài không được lưu kèm; nó theo thời hạn giữ bài như bình thường.
- **Phân loại từng bài:** mới khớp (chỉ B khớp), hết khớp (chỉ A khớp), vẫn khớp nhưng đổi trường trích (chỉ xét các trường có ở cả hai định nghĩa, so giá trị chuẩn hoá), vẫn khớp không đổi, không khớp ở cả hai, và chưa so sánh được (một bên chưa chấm xong, ví dụ lỗi AI).
- **Lý do từng bài:** lý do của mỗi bên (khớp bao nhiêu phần trăm, hoặc bị loại vì sao) kèm gợi ý điểm khác nhau giữa hai định nghĩa (mô tả, chiều cần tìm, lọc người cùng nghề, điều kiện lọc cứng) và giá trị trường trước/sau.
- **Không có tác dụng phụ:** so sánh chạy như xem thử (§5): không tạo tin, liên hệ hay thông báo, không đổi trạng thái hay phiên bản radar nào. Kết quả chấm tạm nằm ở một phạm vi riêng nên không đè lên kết quả xem thử hay kết quả chạy thật của radar, và bị xoá ngay sau khi đọc. Phần duy nhất ghi thêm là nhật ký gọi AI và bản ghi so sánh (giữ 20 bản gần nhất).
- Kết quả do AI chấm nên có thể lệch nhẹ giữa các lần chạy.

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
  "lead_ttl_hours": 72,                 // tuỳ chọn: hạn sống mặc định của tin (xem §2)
  "notify_mode": "instant",             // tuỳ chọn: instant | digest
  "seed_ruleset": "bds-vi-v1"           // tuỳ chọn: bộ luật có sẵn làm tầng lọc rẻ
}
```

### Danh mục khởi đầu

| Ngành | Mẫu | Trường chính | Ý định | Tin còn giá trị · cách báo |
|---|---|---|---|---|
| Bất động sản | Khách cần thuê/mua theo khu vực và tầm giá | loại giao dịch, loại nhà, khu vực, giá, diện tích, số phòng ngủ, SĐT | demand | 3 ngày · ngay |
| Bất động sản | Tin chính chủ | loại giao dịch, khu vực, giá, diện tích, chính chủ, SĐT | supply | 3 ngày · ngay |
| Dịch vụ nhà cửa | Bài hỏi "ai biết thợ…" | loại việc, khu vực, mức gấp, SĐT | demand | 24 giờ · ngay |
| Xe và đồ cũ | Tin bán trong tầm giá bạn đặt | hãng, dòng, đời, giá, số km, khu vực, SĐT | supply | 6 giờ · ngay |
| Tuyển dụng | Người tìm việc | vị trí, kinh nghiệm, khu vực, mức lương mong muốn | supply | 30 ngày · gom |
| Vận tải, ghép hàng | Chủ hàng cần xe (lấp xe trống) | điểm đi, điểm đến, ngày, tải trọng, loại hàng, SĐT | demand | 12 giờ · ngay |
| Order, bán hàng | Bài hỏi mua một loại sản phẩm | sản phẩm, số lượng, ngân sách, khu vực | demand | 48 giờ · ngay |

Ghi chú về hai mẫu:
- **Xe và đồ cũ** không gọi là "dưới giá thị trường", vì app chưa có mốc giá thị trường để so. Người dùng tự đặt trần giá bằng điều kiện cứng trên trường `giá`.
- **Vận tải** chỉ tìm phía chủ hàng (`demand`). Trước đây mẫu dùng `any`, nên bài của nhà xe khác chào xe trống cũng lọt vào. Với người có xe trống, những bài đó là đối thủ, không phải khách.

Mẫu BĐS là mẫu duy nhất có `seed_ruleset` trong MVP, lấy từ bộ luật bất động sản tiếng Việt đã có.

## 8. Giới hạn theo gói

| Giới hạn | Cá nhân | Chuyên nghiệp |
|---|---|---|
| Radar đang chạy | 2 | Không giới hạn |
| Group được theo dõi (tổng) | 10 | 50 |
| Trường mỗi radar | 12 | 20 |

Giới hạn trường tồn tại vì mỗi trường làm dài prompt và giảm độ chính xác trích xuất; con số cần kiểm lại khi đo.
