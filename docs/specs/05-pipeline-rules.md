# Chuỗi xử lý và bộ luật

Trạng thái: nháp v0.1 · 2026-11-11

Tài liệu mô tả đường đi của một bài từ lúc tới desktop đến lúc thành tin, và cách AI sinh bộ luật để các bài sau không cần AI.

## 1. Nguyên tắc

1. **Rẻ trước, đắt sau.** Mỗi tầng loại càng nhiều bài càng tốt với chi phí thấp hơn tầng kế tiếp. AI là tầng cuối và đắt nhất, tính cả bằng thời gian lẫn hạn mức gói AI của người dùng.
2. **Tầng rẻ không được loại nhầm.** Lọc sơ bộ và bộ luật được chỉnh để hiếm khi loại một bài đáng lẽ khớp; khi không chắc, đẩy lên tầng sau.
3. **Mọi quyết định đều truy được.** Mỗi đánh giá ghi tầng nào đã quyết định và vì sao, để người dùng xem lại bài bị loại và để đo từng tầng.

## 2. Tổng quan

```
posts.push
   │
   ▼
[T0 Nhận]         kiểm tra, ghi bài (bất biến theo platform + post_id)
   │
   ▼
[T1 Chuẩn hoá]    text_norm, text_fold, ngôn ngữ, content_hash, simhash
   │
   ▼
[T2 Lọc trùng]    trùng hẳn / gần trùng ─► gắn vào cụm, không đi tiếp
   │
   ▼  với mỗi radar đang chạy có nguồn này
[T3 Lọc sơ bộ]    danh sách chặn, độ dài, từ khoá ─► loại
   │
   ▼
[T4 Bộ luật]      khớp chắc / không khớp chắc ─► quyết định, trích trường
   │ chưa chắc
   ▼
[T5 AI]           gom lô ─► chấm khớp + trích trường
   │
   ▼
[T6 Lọc sau]      người cùng nghề, điều kiện cứng, ngưỡng điểm, kiểm tra bằng chứng
   │
   ▼
[T7 Tạo tin]      ghi lead, xếp thông báo
```

T0–T2 chạy một lần cho mỗi bài. T3–T7 chạy cho từng cặp (bài, radar).

## 3. T1: Chuẩn hoá

| Đầu ra | Cách tính | Dùng cho |
|---|---|---|
| `text_norm` | Unicode NFC; gộp khoảng trắng; bỏ ký tự điều khiển và ký tự độ rộng không | Hiển thị, AI, đối chiếu `raw` |
| `text_fold` | `text_norm` → chữ thường → bỏ dấu tiếng Việt (`đ` → `d`) → thay emoji và ký tự trang trí bằng khoảng trắng | Bộ luật, từ khoá |
| `lang` | Nhận diện ngôn ngữ (crate `whatlang`); bài dưới 20 ký tự để `und` | Thống kê, chọn bộ trích |
| `content_hash` | SHA-256 của `text_fold` sau khi bỏ hết khoảng trắng, dấu câu và chữ số | Trùng hẳn |
| `simhash` | SimHash 64 bit trên các cụm 3 từ của `text_fold` | Gần trùng |

Chữ số bị bỏ khỏi `content_hash` vì người đăng lại thường chỉ đổi giá hoặc số điện thoại.

Bài có chữ viết kiểu trang trí (ký tự toán học in đậm, chữ có khoảng cách) được chuyển về chữ thường bằng chuẩn hoá NFKC trước khi tạo `text_fold`.

## 4. T2: Lọc trùng

- **Trùng hẳn:** cùng `content_hash` trong 14 ngày gần nhất.
- **Gần trùng:** khoảng cách Hamming giữa hai `simhash` ≤ 3 trong 14 ngày, áp dụng cho bài dài từ 80 ký tự; bài ngắn hơn chỉ xét trùng hẳn vì SimHash không ổn định trên văn bản ngắn.
- Tìm gần trùng bằng cách chia `simhash` thành 4 khối 16 bit và tra theo từng khối (hai chuỗi lệch ≤ 3 bit luôn có ít nhất một khối giống hệt).

Bài trùng được gắn vào `dup_clusters` của bài gốc, đặt `is_cluster_head = 0`, và **không đi tiếp**. Nếu bài gốc đã thành tin, tin đó được cập nhật `also_seen_in`; không gửi thông báo lần nữa.

Ngoại lệ: nếu bài trùng xuất hiện sau bài gốc hơn 72 giờ, coi là đăng lại có chủ đích và cho đi tiếp như bài mới (nhu cầu có thể vẫn còn).

Số group và số lần một cụm xuất hiện là tín hiệu cho T6: một nội dung đăng ở 8 group trong một giờ hiếm khi là khách thật.

## 5. T3: Lọc sơ bộ

Loại ngay, không cần AI, theo thứ tự:

1. Tác giả hoặc số điện thoại trong bài thuộc `blocklist` → `blocked`.
2. Bài rỗng hoặc dưới 15 ký tự và không có ảnh → `prefilter`.
3. Bài chỉ có đường dẫn → `prefilter`.
4. Phần `prefilter` của bộ luật đang chạy (§6.2), nếu có → `prefilter`.

Radar chưa có bộ luật vẫn chạy được bước 1–3.

## 6. Bộ luật (ruleset)

### 6.1 Vai trò

Bộ luật là dữ liệu JSON theo một DSL cố định, do AI sinh ra từ các bài đã có nhãn, và được bộ máy trong `crates/rules` thực thi ([ADR-006](../architecture/02-decisions.md#adr-006-bộ-luật-là-dsl-khai-báo-không-phải-mã-do-ai-sinh)). Nó trả lời yêu cầu trong bản ý tưởng: sau khi AI đã phân tích đủ, các lần sau lọc và phân loại được mà không cần AI.

Kỳ vọng thực tế: bộ luật giỏi ở hai việc là loại bài rõ ràng không liên quan (thường là phần lớn lưu lượng) và trích các trường có hình dạng cố định (tiền, SĐT, diện tích, địa danh). Bài mơ hồ, mỉa mai, viết tắt lạ, hoặc cần hiểu ngữ cảnh vẫn phải lên AI.

### 6.2 Cấu trúc

```jsonc
{
  "dsl": 1,
  "prefilter": {
    // Bài phải chứa ít nhất một mục trong "any", và không chứa mục nào trong "none".
    // Khớp trên text_fold. Tiền tố "re:" là biểu thức chính quy.
    "any":  ["can thue", "tim phong", "tim nha", "can tim", "re:\\bthue\\b"],
    "none": ["cho thue", "chinh chu cho thue", "tuyen dung"],
    "min_len": 20
  },

  "classify": [
    {
      "id": "r1",
      "when": {
        "all": [
          {"kw_any": ["can thue", "tim thue", "muon thue"]},
          {"kw_none": ["cho thue", "ben em co", "hoa hong", "ib em"]},
          {"has_field": "location"}
        ]
      },
      "verdict": "match",
      "confidence": 0.92,
      "set": {"intent": "demand"}
    },
    {
      "id": "r2",
      "when": {"kw_any": ["ben em co", "quy can", "hoa hong", "ky gui"]},
      "verdict": "no_match",
      "confidence": 0.9,
      "set": {"author_role": "peer"}
    }
  ],

  "extract": [
    {"field": "price", "extractor": "vn_money",
     "near": ["gia", "tam", "khoang", "duoi", "tai chinh", "ngan sach"], "window": 40},
    {"field": "location", "extractor": "gazetteer", "dict": "vn_admin", "scope": "Hà Nội"},
    {"field": "phone", "extractor": "vn_phone"},
    {"field": "bedrooms", "extractor": "regex",
     "pattern": "(\\d)\\s*(pn|phong ngu|ngu)\\b", "group": 1, "cast": "int"},
    {"field": "deal_type", "extractor": "enum_kw",
     "map": {"rent": ["thue"], "buy": ["mua"]}}
  ],

  "thresholds": {"accept": 0.9, "reject": 0.9}
}
```

**Điều kiện** (`when`): `all`, `any`, `not` lồng nhau trên các vị từ `kw_any`, `kw_none`, `re`, `has_field` (bộ trích của trường đó tìm thấy giá trị), `len_lt`, `len_gt`, `lang_in`, `field_cmp` (so sánh giá trị đã trích).

**Kết quả phân loại:** luật được xét theo thứ tự; luật đầu tiên khớp cho ra `verdict` và `confidence`. Không luật nào khớp → `uncertain`.

**Quyết định của T4:**

| Kết quả | Điều kiện | Hành động |
|---|---|---|
| Khớp chắc | `verdict = match`, `confidence ≥ thresholds.accept`, và mọi trường bắt buộc đã được trích | Đi thẳng T6, không gọi AI |
| Không khớp chắc | `verdict = no_match`, `confidence ≥ thresholds.reject` | Loại, `decided_by = rule` |
| Chưa chắc | Còn lại | Lên T5; giá trị bộ luật đã trích được gửi kèm làm gợi ý |

### 6.3 Bộ trích dựng sẵn

Viết bằng Rust, kiểm thử dày, dùng chung cho mọi radar. AI chỉ chọn và cấu hình chúng.

| Bộ trích | Nhận ra | Ví dụ |
|---|---|---|
| `vn_money` | Số tiền viết kiểu Việt, đơn và khoảng, kèm chu kỳ | `3tr5`, `2 tỷ 3`, `15 củ`, `12-15tr/th`, `dưới 400 triệu`, `1.2 tỉ` |
| `vn_phone` | Số di động và cố định, kể cả viết cách, viết chấm, viết chữ lẫn số | `0912.345.678`, `09 1234 5678`, `o912 345 678` |
| `vn_area` | Diện tích | `50m2`, `50 m²`, `5x20`, `70 mét vuông` |
| `gazetteer` | Địa danh theo từ điển hành chính, có biệt danh và viết tắt | `q7`, `Cầu Giấy`, `tp thủ đức`, `HN` |
| `number` | Số kèm đơn vị cấu hình được | `3 tấn`, `đời 2019`, `5 vạn km` |
| `date_vi` | Ngày tuyệt đối và tương đối, tính từ ngày đăng | `mai`, `cuối tuần`, `15/11`, `đầu tháng sau` |
| `enum_kw` | Ánh xạ từ khoá sang giá trị cố định | |
| `regex` | Mẫu tuỳ ý có nhóm bắt | |

Mỗi bộ trích trả về giá trị chuẩn hoá, đoạn `raw` và vị trí trong văn bản. Từ điển hành chính (`vn_admin`) đi kèm app và phải theo kịp thay đổi đơn vị hành chính; cần chọn nguồn dữ liệu và có cách cập nhật.

Bộ luật BĐS tiếng Việt đã có được chuyển sang định dạng này làm bộ luật `origin = seed` cho mẫu BĐS, và các biểu thức nhận dạng tiền, diện tích, địa danh trong đó là điểm khởi đầu cho các bộ trích trên.

### 6.4 Vòng đời

```
            sinh              đạt cổng               đạt cổng
(không) ─────────► candidate ─────────► shadow ─────────────► active ─────► retired
                       │ không đạt          │ không đạt           │ kiểm tra định kỳ
                       ▼                    ▼                     │ không đạt
                    (bỏ)                 (bỏ)                     └────► shadow
```

**Sinh** (`compile_ruleset`, P1). Kích hoạt khi một phiên bản radar có ít nhất 150 đánh giá do AI quyết định, trong đó ít nhất 20 khớp, và có ít nhất 30 đánh giá mới kể từ lần sinh trước. Đầu vào gửi cho AI: định nghĩa radar, DSL và danh sách bộ trích, tối đa 120 bài mẫu có nhãn (ưu tiên phản hồi của người dùng, sau đó là kết quả AI có điểm cao và thấp rõ rệt), và bộ luật hiện tại nếu có. Xem [AI bridge §5.3](06-ai-bridge.md#53-compile_rules).

**Cổng candidate → shadow.** Chạy bộ luật trên tập kiểm định giữ riêng (20% dữ liệu có nhãn, không gửi cho AI khi sinh):

| Phép đo | Ngưỡng |
|---|---|
| Hợp lệ theo schema, mọi biểu thức chính quy biên dịch được, không biểu thức nào chạy quá 1 ms trên bài 5.000 ký tự | Bắt buộc |
| Tỉ lệ loại nhầm: bài có nhãn khớp bị bộ luật loại chắc | ≤ 2% |
| Độ chính xác của "khớp chắc" | ≥ 95% |
| Trường do bộ luật trích trùng với nhãn | ≥ 90% mỗi trường; trường không đạt bị bỏ khỏi `extract` |

**Shadow.** Bộ luật chạy song song với AI trên bài thật nhưng không quyết định gì; kết quả được so với AI. Sau 200 bài hoặc 3 ngày, nếu vẫn đạt các ngưỡng trên thì lên `active`.

**Active.** Bộ luật quyết định ở T3 và T4. Kiểm tra định kỳ (`audit_ruleset`): mỗi ngày lấy ngẫu nhiên 5% số bài bộ luật đã tự quyết (tối đa 30 bài) gửi lên AI. Nếu tỉ lệ bất đồng trong 7 ngày vượt 8%, bộ luật quay về `shadow` và một lần sinh mới được lên lịch.

**Retired.** Khi có bản thay thế lên `active`, hoặc khi radar có phiên bản mới.

Phản hồi của người dùng luôn thắng: một bài người dùng đánh dấu sai mà bộ luật đã tự quyết sẽ kích hoạt kiểm tra ngay, không chờ chu kỳ.

### 6.5 Hiển thị cho người dùng

Trang radar hiện một câu tóm tắt ("Bộ luật đang tự xử lý 82% số bài, AI xử lý 18%") và cho xem bộ luật ở dạng đọc được: danh sách từ khoá nhận và loại, các trường tự trích. Người dùng nâng cao thêm bớt từ khoá được; thay đổi đó tạo bản `origin = user` và đi lại qua cổng kiểm định.

## 7. T5: AI

Chi tiết lời gọi ở [06-ai-bridge.md](06-ai-bridge.md). Ở tầng chuỗi xử lý:

- Bài chưa chắc được ghi `evaluations.state = 'pending_ai'`.
- Công việc `evaluate_batch` cho một phiên bản radar được tạo khi có bài chờ, chạy khi đủ 20 bài hoặc bài cũ nhất đã chờ 45 giây.
- Một lô chỉ chứa bài của cùng một phiên bản radar (cùng định nghĩa trường, cùng ví dụ).
- Bài dài hơn 2.500 ký tự bị cắt: giữ 1.800 ký tự đầu và 500 ký tự cuối, vì thông tin liên hệ thường ở cuối.
- Khi AI lỗi hoặc hết hạn mức, bài ở lại `pending_ai`. Bài chờ quá 6 giờ vẫn được chấm khi AI trở lại nhưng tin sinh ra không gửi thông báo tức thời, chỉ vào Hộp tin.

## 8. T6: Lọc sau

Áp dụng cho mọi bài được chấm khớp, dù bởi bộ luật hay AI.

1. **Kiểm tra bằng chứng.** Với mỗi trường, `raw` phải là chuỗi con của `text_norm` (so không phân biệt hoa thường và khoảng trắng). Không đạt thì bỏ giá trị trường đó. Nếu trường bị bỏ là trường bắt buộc, trừ 0,2 điểm.
2. **Chuẩn hoá lại.** Chạy bộ trích dựng sẵn tương ứng trên `raw` để có giá trị chuẩn (AI trả `raw`, bộ trích quyết định con số). Nếu AI và bộ trích cho giá trị khác nhau, tin bộ trích và hạ `confidence` của trường.
3. **Người cùng nghề.** Loại nếu `author_role = peer` và radar đặt `exclude_roles` chứa `peer`. Tín hiệu bổ sung, cộng vào đánh giá của AI:
   - Tác giả đăng từ 5 bài trở lên trong 7 ngày ở các nguồn đang theo dõi.
   - Cụm trùng của bài xuất hiện ở 4 nguồn trở lên.
   - Số điện thoại trong bài đã xuất hiện trong bài của 3 tác giả khác nhau trở lên.
   - Hai tín hiệu trở lên cùng xuất hiện thì ghi đè `author_role` thành `peer` dù AI nói khác.
4. **Điều kiện cứng.** Áp `match_policy.hard_filters` lên giá trị đã chuẩn hoá. Trường thiếu thì theo `when_missing`.
5. **Ngưỡng điểm.** `score ≥ notify.min_score` thì tạo tin và báo; `0,4 ≤ score < min_score` thì tạo tin nhưng không báo (hiện ở Hộp tin với nhãn "khớp yếu"); dưới 0,4 thì không tạo tin.

## 9. T7: Tạo tin

- Ghi `leads` với bản sao `fields` (bản người dùng sửa được), `also_seen_in` từ cụm trùng.
- P1: tìm hoặc tạo `contacts` theo số điện thoại rồi theo tác giả.
- Ghi `lead_events(kind = created)`.
- Xếp `notify_lead` nếu đạt điều kiện báo ([Thông báo §3](07-notifications-export.md#3-quy-tắc-gửi)).
- Đẩy sự kiện `lead:new` lên giao diện.

## 10. Chế độ xem thử

Cùng chuỗi xử lý với `is_preview = 1`: bỏ qua T2 (bài trùng vẫn được chấm để người dùng thấy), không ghi `leads`, không xếp thông báo, lô AI nhỏ hơn (10 bài) để kết quả hiện dần. Kết quả xem thử bị xoá khi radar được bật hoặc sau 24 giờ.

## 11. Đo lường từng tầng

Trang radar và trang Sức khoẻ hiện phễu 7 ngày, lấy từ `evaluations.decided_by` và `reject_reason`:

```
Bài thu được            10.000
├─ trùng                 1.800   (18%)
├─ lọc sơ bộ loại        5.900   (59%)
├─ bộ luật quyết định    1.100   (11%)   trong đó khớp: 140
└─ AI quyết định         1.200   (12%)   trong đó khớp: 95
Tin tạo ra                 198   → đã báo 171, khớp yếu 27
Bị đánh dấu sai             14   (8% số tin đã báo)
```

Các con số trên là ví dụ minh hoạ cách trình bày, không phải số liệu đo được.
