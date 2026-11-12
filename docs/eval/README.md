# Bộ Đánh giá Chuẩn Đa ngành & Hướng dẫn Chạy Benchmark (`docs/eval/`)

Thư mục này chứa **Tập dữ liệu Vàng (Golden Evaluation Suite)** đa ngành – đa ngôn ngữ và kết quả đường cơ sở của DealSonar theo đặc tả tại [`docs/delivery/02-validation-plan.md (§3.1–3.3)`](../delivery/02-validation-plan.md) và [`docs/specs/06-ai-bridge.md (§8)`](../specs/06-ai-bridge.md).

Mọi thay đổi đối với khung nhắc (prompt), bộ trích xuất trường, hoặc adapter CLI (`claude`, `codex`, `agy`) trong `crates/ai-bridge` đều phải chạy qua bộ đánh giá này và vượt toàn bộ ngưỡng chất lượng **Giả thuyết H2** trước khi phát hành.

---

## 1. Cấu trúc thư mục & Quy tắc Ẩn danh (0% PII)

```text
docs/eval/
├── README.md                        # Tài liệu hướng dẫn & bảng kết quả benchmark này
├── baseline-mock.json               # Kết quả JSON máy đọc (4 bộ dữ liệu × 4 cỡ lô = 16 lượt chạy)
└── golden/
    ├── bds.radar.json               # Cấu hình Radar Bất động sản (săn khách tìm thuê / tìm mua)
    ├── bds.jsonl                    # 65 bài đăng BĐS gán nhãn chuẩn
    ├── dich-vu.radar.json           # Cấu hình Radar Dịch vụ dân dụng ("ai biết thợ...")
    ├── dich-vu.jsonl                # 45 bài đăng Dịch vụ dân dụng gán nhãn chuẩn
    ├── xe-cu.radar.json             # Cấu hình Radar Ô tô cũ chính chủ
    ├── xe-cu.jsonl                  # 45 bài đăng Mua bán ô tô cũ gán nhãn chuẩn
    ├── multilingual.radar.json      # Cấu hình Radar BĐS Expat (Anh & song ngữ Anh–Việt)
    └── multilingual.jsonl           # 30 bài đăng tiếng Anh / song ngữ gán nhãn chuẩn
```

> [!IMPORTANT]
> **Cam kết 0% Dữ liệu Cá nhân Thật (Zero PII):** Toàn bộ **185 mẫu** trong `docs/eval/golden/*.jsonl` đều dùng tên tác giả tổng hợp và số điện thoại giả định kiểm thử (`0912.345.678`, `+84 909 111 222`, v.v.). Khi bổ sung mẫu mới vào kho mã nguồn, tuyệt đối **không** sao chép tên thật, đường dẫn trang cá nhân thật hoặc số điện thoại thật từ mạng xã hội.

---

## 2. Lược đồ Dữ liệu (`GoldenSample` & `RadarPromptContext`)

Các tệp trong `golden/` tương thích 100% với trình chạy `cargo run -p dealsonar-ai-bridge --bin eval` (`crates/ai-bridge/src/eval.rs`):

- **Mỗi dòng trong `<tên>.jsonl` (`GoldenSample`):**
  - `id` (`string`): Mã định danh duy nhất của mẫu (ví dụ `"bds-001"`).
  - `group_name` (`string | null`): Tên hội nhóm giả lập cung cấp ngữ cảnh địa lý/ngành.
  - `author_name` (`string | null`): Tên người đăng tổng hợp (`null` với bài đăng ẩn danh).
  - `created_at_ms` (`number | null`): Mốc thời gian Unix tính bằng mili-giây.
  - `text` (`string`): Toàn văn bài đăng (bao gồm viết tắt tiếng Việt, không dấu, emoji, bài cực ngắn/cực dài, câu mồi môi giới, hoặc bẫy prompt injection).
  - `expected_match` (`boolean`): Nhãn chuẩn bài đăng có khớp mục tiêu săn của Radar hay không.
  - `expected_author_role` (`"end_user" | "peer" | "unknown" | null`): Nhãn chuẩn vai trò tác giả (`"peer"` là môi giới, cò, salon xe, thợ/đơn vị thi công cùng ngành trá hình).
  - `expected_fields` (`object`): Giá trị chuẩn của các trường trích xuất (chỉ chấm trên các mẫu `expected_match = true`), đối chiếu theo chuẩn hóa chuỗi NFC chữ thường và tương đương số học (`15` khớp `15.0`).
- **Tệp `<tên>.radar.json`:** Khai báo ngữ cảnh Radar (`radar_version_id`, `description`, `user_profession`, `language_hint`, `want_intent`, `exclude_roles`, `match_policy`, `seed_ruleset`, và danh sách `fields` kèm kiểu dữ liệu `enum`, `money`, `location`, `range`, `number`, `boolean`, `phone`).

---

## 3. Ngưỡng Nghiệm thu Giả thuyết H2 (`02-validation-plan.md §3.2`)

Trình chạy `eval` tự động kiểm tra và trả mã thoát `0` khi đạt đồng thời tất cả các ngưỡng sau (trả mã thoát `2` nếu vi phạm bất kỳ ngưỡng nào):

| Chỉ số | Ngưỡng bắt buộc | Ý nghĩa nghiệp vụ |
|---|---|---|
| `match_precision` | **`≥ 85,00%`** | Tối đa 15% thông báo gửi tới người dùng là nhiễu dương tính giả |
| `match_recall` | **`≥ 90,00%`** | Không bỏ lọt quá 10% cơ hội khách hàng / nguồn hàng thật |
| `peer_precision` | **`≥ 75,00%`** | Nhận diện đúng bài của đồng nghiệp / môi giới cùng ngành |
| `peer_recall` | **`≥ 75,00%`** | Chặn được tối thiểu 3/4 lượng bài rao vặt trá hình của cò / salon / thợ |
| Độ chính xác trường `required` | **`≥ 90,00%`** | Trường cốt lõi (`deal_type`, `location`, `service_type`, `model`) phải chuẩn xác |
| Độ chính xác trường `optional` | **`≥ 80,00%`** | Trường bổ trợ (`price`, `area`, `bedrooms`, `phone`, `year`, ...) đạt chuẩn lọc |
| `hallucinated_raw_rate` | **`≤ 1,00%`** | Cấm AI tự bịa trích dẫn `raw` không xuất hiện nguyên văn trong bài đăng |

---

## 4. Kết quả Đường cơ sở Ngoại tuyến (`--provider mock`)

Dữ liệu chi tiết của toàn bộ **16 lượt chạy** (`4` bộ dữ liệu × `4` cỡ lô `5, 10, 20, 40`) được lưu tại [`baseline-mock.json`](./baseline-mock.json). Tất cả **16/16 lượt chạy đều ĐẠT 100% ngưỡng H2** với mã thoát `0`.

### 4.1. Độ chính xác Phân loại & Trích xuất (cấu hình chuẩn `--batch-size 20`)

| Bộ dữ liệu | Số bài (Khớp / Peer / Khác) | Match Precision | Match Recall | Match F1 | Peer Precision | Peer Recall | Tỷ lệ bịa `raw` | Độ chính xác trường bắt buộc | Độ chính xác trường tùy chọn thấp nhất | Kết luận |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **`bds`** | `65` *(20 / 20 / 25)* | **100,00%** | **100,00%** | **100,00%** | **100,00%** | **95,00%** | **0,00%** *(0/316)* | `deal_type` **95,00%**, `location` **95,00%** | `phone` **94,74%** *(18/19)* | **[ĐẠT]** |
| **`dich-vu`** | `45` *(14 / 12 / 19)* | **100,00%** | **92,86%** | **96,30%** | **100,00%** | **91,67%** | **0,00%** *(0/122)* | `service_type` **100,00%** | Tất cả **100,00%** | **[ĐẠT]** |
| **`xe-cu`** | `45` *(14 / 12 / 19)* | **100,00%** | **100,00%** | **100,00%** | **100,00%** | **91,67%** | **0,00%** *(0/213)* | `model` **100,00%** | `year` **85,71%** *(12/14)* | **[ĐẠT]** |
| **`multilingual`** | `30` *(10 / 9 / 11)* | **100,00%** | **90,00%** | **94,74%** | **100,00%** | **88,89%** | **0,00%** *(0/132)* | `deal_type` **100,00%**, `location` **100,00%** | `phone` **90,00%** *(9/10)* | **[ĐẠT]** |

### 4.2. So sánh Chi phí Token & Số lần gọi theo Kích thước Lô (`batch_size = 5, 10, 20, 40`)

Chất lượng phân loại và trích xuất trên đường cơ sở tất định giữ nguyên qua mọi kích thước lô, trong khi chi phí `input_tokens / bài` giảm mạnh nhờ khấu hao phần System Prompt & JSON Schema dùng chung:

| Bộ dữ liệu | Cỡ lô `5` *(số lệnh · token vào/bài · token ra/bài)* | Cỡ lô `10` *(số lệnh · token vào/bài · token ra/bài)* | Cỡ lô `20` *(số lệnh · token vào/bài · token ra/bài)* | Cỡ lô `40` *(số lệnh · token vào/bài · token ra/bài)* |
|---|---|---|---|---|
| **`bds`** *(65 bài)* | `13` lệnh · `263,2` in · `224,3` out | `7` lệnh · `187,8` in · `224,0` out | **`4` lệnh · `150,1` in · `223,9` out** | `2` lệnh · `124,9` in · `223,8` out |
| **`dich-vu`** *(45 bài)* | `9` lệnh · `246,9` in · `185,0` out | `5` lệnh · `176,8` in · `184,8` out | **`3` lệnh · `141,8` in · `184,7` out** | `2` lệnh · `124,2` in · `184,6` out |
| **`xe-cu`** *(45 bài)* | `9` lệnh · `251,3` in · `212,8` out | `5` lệnh · `179,9` in · `212,5` out | **`3` lệnh · `144,2` in · `212,4` out** | `2` lệnh · `126,4` in · `212,3` out |
| **`multilingual`** *(30 bài)* | `6` lệnh · `249,3` in · `216,7` out | `3` lệnh · `170,4` in · `216,4` out | **`2` lệnh · `144,1` in · `216,3` out** | `1` lệnh · `117,8` in · `216,2` out |

---

## 5. Hướng dẫn Chạy Lại Benchmark bằng CLI

### 5.1. Chạy kiểm tra ngoại tuyến nhanh (`mock` — không cần mạng hay tài khoản AI)

```bash
# Chạy từng bộ dữ liệu chuẩn (mặc định --provider mock --batch-size 20)
cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/bds.jsonl \
  --radar docs/eval/golden/bds.radar.json

cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/dich-vu.jsonl \
  --radar docs/eval/golden/dich-vu.radar.json

cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/xe-cu.jsonl \
  --radar docs/eval/golden/xe-cu.radar.json

cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/multilingual.jsonl \
  --radar docs/eval/golden/multilingual.radar.json
```

Xuất kết quả định dạng JSON máy đọc (ví dụ ở cỡ lô `40`):

```bash
cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/bds.jsonl \
  --radar docs/eval/golden/bds.radar.json \
  --batch-size 40 \
  --json
```

### 5.2. Chạy đánh giá trên Nhà cung cấp CLI Thật (`claude`, `codex`, `agy`)

Đảm bảo máy đã cài đặt và đăng nhập sẵn công cụ CLI tương ứng (`claude`, `codex`, hoặc `agy`). Cầu nối sẽ tự động tạo thư mục rỗng tạm thời `ai-workdir` và bật cờ cô lập sandbox đọc-chỉ-đọc / tắt toàn bộ công cụ thực thi trước khi gửi bài:

```bash
# 1. Claude Code CLI — đối chiếu hạng nhanh (Haiku) và hạng thông minh (Sonnet)
cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/bds.jsonl \
  --radar docs/eval/golden/bds.radar.json \
  --provider claude --tier fast --batch-size 20

cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/bds.jsonl \
  --radar docs/eval/golden/bds.radar.json \
  --provider claude --tier smart --batch-size 20

# 2. OpenAI Codex CLI — chạy kiểm chứng ở cả hạng fast và smart
cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/bds.jsonl \
  --radar docs/eval/golden/bds.radar.json \
  --provider codex --tier fast --batch-size 20

cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/bds.jsonl \
  --radar docs/eval/golden/bds.radar.json \
  --provider codex --tier smart --batch-size 20

# 3. Antigravity CLI (agy) — kiểm chứng trích xuất tiếng Việt & đa ngôn ngữ
cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/bds.jsonl \
  --radar docs/eval/golden/bds.radar.json \
  --provider agy --tier fast --batch-size 20

cargo run -p dealsonar-ai-bridge --bin eval -- \
  --dataset docs/eval/golden/multilingual.jsonl \
  --radar docs/eval/golden/multilingual.radar.json \
  --provider agy --tier smart --batch-size 20
```

Bạn cũng có thể chỉ định đích danh tên mô hình qua cờ `--model <tên-model>` và quét ma trận kích thước lô để đo chi phí thực tế:

```bash
for bs in 5 10 20 40; do
  cargo run -p dealsonar-ai-bridge --bin eval -- \
    --dataset docs/eval/golden/bds.jsonl \
    --radar docs/eval/golden/bds.radar.json \
    --provider claude --tier fast --batch-size "$bs" --json \
    > "/tmp/eval-claude-fast-b${bs}.json"
done
```

---

## 6. Tài liệu Tham chiếu Liên quan

- Báo cáo tổng hợp Spike S1–S4:
  - [`docs/spikes/S1-extension-extraction.md`](../spikes/S1-extension-extraction.md) — Trích xuất 3 tầng trên trình duyệt & giới hạn tốc độ cứng.
  - [`docs/spikes/S2-cli-ai-adapters.md`](../spikes/S2-cli-ai-adapters.md) — Ma trận cờ CLI AI, cô lập bảo mật & chia đôi lô lỗi (batch bisection).
  - [`docs/spikes/S3-native-ipc-relay.md`](../spikes/S3-native-ipc-relay.md) — Chịu tải cầu nối Native Messaging ↔ Local IPC (1.200+ khung tin đồng thời).
  - [`docs/spikes/S4-vietnamese-eval-baseline.md`](../spikes/S4-vietnamese-eval-baseline.md) — Phân tích chi tiết Tập dữ liệu Vàng, bộ luật `bds-vi-v1` và đường cơ sở AI Bridge.
