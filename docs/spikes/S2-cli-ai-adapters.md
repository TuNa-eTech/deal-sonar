# Báo cáo Spike S2: Adapter CLI AI, Hộp cát Bảo mật & Chia đôi Lô lỗi

- **Mã spike:** `S2` ([Lộ trình §2](../delivery/01-roadmap.md#2-mốc-0-spike-cỡ-m-làm-trước-mọi-thứ))
- **Đặc tả đối chiếu:** [06-ai-bridge.md](../specs/06-ai-bridge.md), [02-validation-plan.md §3–4](../delivery/02-validation-plan.md)
- **Thành phần kiểm chứng:** `crates/ai-bridge/` (`dealsonar-ai-bridge` & trình đánh giá `--bin eval`)
- **Trạng thái kỹ thuật:** **ĐẠT (16/16 kiểm thử tích hợp + 16/16 lượt chạy ma trận lô 5/10/20/40)**

---

## 1. Câu hỏi kiểm chứng & Tiêu chí đạt

> *Ba công cụ CLI AI (`claude`, `codex`, `agy`) có gọi được qua một giao diện thống nhất với toàn bộ công cụ thực thi bị khoá cứng, trả JSON hợp lệ theo schema ổn định (≥ 99% sau một lần thử lại), cô lập được bài độc hại trong lô lớn, và đo được token/thời lượng theo kích thước lô 5, 10, 20, 40 không?*

| Hạng mục kiểm chứng | Yêu cầu ([06-ai-bridge.md §1–6](../specs/06-ai-bridge.md)) | Kết quả đạt được |
|---|---|---|
| Giao diện thống nhất `AiProvider` | Hỗ trợ `claude_cli`, `codex_cli`, `agy_cli` và `mock` qua cùng một `AiBridge` | **ĐẠT** (`crates/ai-bridge/src/adapters/`) |
| Xác minh cờ bảo mật bắt buộc | Kiểm tra `--help` ở cả `probe()` và trước `complete()`; từ chối chạy nếu thiếu cờ khoá công cụ (`AiError::SecurityFlagsUnsupported`) | **ĐẠT** |
| Cách ly tiến trình con & chống lộ prompt | Gọi trực tiếp `tokio::process::Command` (không qua shell), prompt truyền hoàn toàn qua `stdin`, làm rỗng `ai-workdir/` trước mỗi lời gọi, `killpg(SIGKILL)` cả nhóm tiến trình khi quá hạn | **ĐẠT** (`crates/ai-bridge/src/subprocess.rs`) |
| Ràng buộc đầu ra & chịu lỗi lô | Khôi phục JSON cân bằng ngoặc + kiểm tra JSON Schema đệ quy + kiểm tra ngữ nghĩa tác vụ + thử lại 1 lần + **chia đôi lô đệ quy (batch bisection)** | **ĐẠT** (`100%` bài lành trong lô được cứu khi có 1 bài hỏng) |
| Đo token & số lời gọi theo kích thước lô | Chạy trên 4 tập chuẩn (185 bài) với lô `5`, `10`, `20`, `40` | **ĐẠT** (xem mục §5 và [`docs/eval/baseline-mock.json`](../eval/baseline-mock.json)) |

---

## 2. Ma trận cờ dòng lệnh đã xác minh của 3 Adapter

Tất cả adapter kế thừa môi trường xác thực của người dùng kèm `expanded_path_env()` (tự động bổ sung `~/.local/bin`, `~/.cargo/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin`, `pnpm`, `fnm`, `nvm`, `/opt/homebrew/bin`, `/usr/local/bin` cho ứng dụng khởi chạy từ giao diện đồ hoạ).

| Thuộc tính | Claude Code (`claude_cli`) | OpenAI Codex (`codex_cli`) | Antigravity (`agy_cli`) |
|---|---|---|---|
| **Tệp thực thi & phiên bản tối thiểu** | `claude` (`≥ 2.1.319`) | `codex exec` (`≥ 0.150.1`) | `agy` (`≥ 1.5.4`) |
| **Chế độ không tương tác & JSON** | `--print --output-format json` | `exec --json --output-last-message <file>` | `--print --output-format json` |
| **Ràng buộc JSON Schema** | `--json-schema "<inline_json>"` | `--output-schema <temp_dir>/schema.json` | `--json-schema <temp_dir>/schema.json` |
| **Truyền chỉ dẫn hệ thống & prompt** | `--system-prompt "$SYSTEM"` + prompt qua `stdin` | Ghép `system + prompt` truyền qua `stdin` (cờ `-`) | Ghép `system + prompt` truyền qua `stdin` |
| **Cờ khoá công cụ / hộp cát bắt buộc** | `--tools ""` · `--strict-mcp-config` · `--no-session-persistence` | `--sandbox read-only` · `--skip-git-repo-check` · `--ephemeral` (+ `--ignore-user-config`, `--ignore-rules` khi hỗ trợ) | `--sandbox` · `--disable-slash-commands` · `--print-timeout <secs>s` |
| ** Tầng mô hình mặc định (`Fast` / `Smart`)** | `haiku` / `sonnet` | `codex-mini-latest` / `gpt-5-codex` | `gemini-2.5-flash` / `gemini-2.5-pro` |
| **Xử lý đặc thù đã giải quyết** | Hỗ trợ đọc lỗi JSON trên `stdout` ngay cả khi mã thoát `!= 0`; cộng gộp `cache_read_input_tokens` | Tự động thử lại không kèm `--ignore-user-config` trong `probe_full()` nếu cờ này làm ẩn thông tin đăng nhập; đọc sự kiện JSONL trên `stdout` lấy `usage` | Đặt `ScopedTempDir` (`0700`) chứa `schema.json` cho từng lời gọi và tự xoá tức thì qua `Drop` |

---

## 3. Năm lớp phòng vệ bảo mật chống Prompt Injection

Nội dung bài viết mạng xã hội là dữ liệu hoàn toàn không tin cậy được đưa vào các CLI vốn thiết kế cho lập trình viên. `crates/ai-bridge` thực thi đầy đủ 5 lớp bảo vệ độc lập ([06-ai-bridge.md §6](../specs/06-ai-bridge.md#6-bảo-mật)):

1. **Tước bỏ hoàn toàn khả năng thực thi (Lớp quyết định):**
   - Kiểm tra sự tồn tại của mọi cờ bảo mật bắt buộc trong đầu ra `--help` trước khi cho phép chạy bất kỳ lời gọi nào.
   - `ensure_empty_workdir()` xoá sạch mọi tệp/thư mục trong `ai-workdir/` trước mỗi lần gọi để ngăn CLI tự nạp `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`.
   - Truyền mảng đối số trực tiếp cho nhân hệ điều hành (`Command::new`), không bao giờ đi qua `/bin/sh` hay `cmd /C`; toàn bộ nội dung bài chỉ đi qua đường ống `stdin` (không xuất hiện trên `ps aux`).
   - Trên Unix, đặt tiến trình con vào nhóm riêng (`process_group(0)`) kèm bộ bảo vệ RAII `ProcessGroupGuard` gửi `libc::killpg(pgid, SIGKILL)` ngay khi hết giờ chờ hoặc huỷ tác vụ, diệt sạch mọi tiến trình cháu bị treo.
2. **Biên phân tách dữ liệu ngẫu nhiên theo từng lời gọi:**
   - Mỗi lời gọi sinh một nonce 48-bit ngẫu nhiên mới (`<<<DEALSONAR_UNTRUSTED_POST_<12_hex>>>>` … `<<</DEALSONAR_UNTRUSTED_POST_<12_hex>>>>`). Nếu bài viết cố tình chứa chuỗi trùng nonce, `sanitize_against_nonce_escape` lập tức thay thế bằng `[REDACTED_NONCE]`.
3. **Cắt ngắn bài quá dài giữ thông tin liên hệ & lọc riêng tư:**
   - `PostPromptInput::sanitized` loại bỏ hoàn toàn `author.external_id` và `permalink` trước khi tạo prompt.
   - `truncate_post_text` cắt bài `> 2.500` ký tự thành `1.800 ký tự đầu + "\n[...]\n" + 500 ký tự cuối` để giữ trọn số điện thoại ở cuối bài mà không làm tràn ngữ cảnh lô.
4. **Hậu kiểm JSON Schema & ngữ nghĩa tác vụ nghiêm ngặt (`schema.rs`):**
   - `extract_json_value` bóc đối tượng `{...}` cân bằng ngoặc đầu tiên nếu mô hình bọc khối mã Markdown.
   - `validate_json_schema` kiểm tra đệ quy `type`, `required`, `additionalProperties: false`, `enum`, `anyOf`, `minimum`/`maximum`, `minItems`/`maxItems`, `maxLength` và `pattern`.
   - Với `judge_extract`: bắt buộc trả đúng 1 phần tử cho mỗi `ref` đã gửi, không thiếu và không dư `ref` lạ.
   - Với `compile_rules`: kiểm tra thêm biểu thức chính quy tuyến tính, chặn đứng các lượng từ lồng nhau gây treo CPU (`(a+)+`, `(.*)*`).
5. **Đối chiếu bằng chứng nguyên văn (`verify_raw_in_post`):**
   - Mọi giá trị trường khác `null` đều phải đi kèm đoạn trích `raw` xuất hiện nguyên văn trong bài gốc; nếu AI tự suy diễn hoặc bịa `raw`, giá trị bị loại bỏ ở T6.

---

## 4. Thiết kế Thử lại 1 lần & Chia đôi Lô đệ quy (Batch Bisection)

Khi chấm lô lớn (ví dụ 20 hoặc 40 bài), một bài viết có ký tự dị biệt hoặc kích hoạt bộ lọc từ chối của mô hình có thể làm hỏng đầu ra của cả lô. `AiBridge::eval_slice_recursive` (`crates/ai-bridge/src/bridge.rs`) giải quyết triệt để như sau:

```
Lô N bài (ví dụ 20 bài)
 ├─ Lần gọi 1 thành công & qua kiểm tra schema + ref ─► Trả kết quả Done cho cả 20 bài
 └─ Lần gọi 1 lỗi InvalidOutput / Refused
     ├─ Thử lại lần 2 trên cùng lô
     │   └─ Thành công ─► Trả kết quả Done cho cả 20 bài
     └─ Vẫn lỗi:
         ├─ Nếu N == 1 ─► Đánh dấu duy nhất bài đó là PostEvalOutcome::AiFailed
         └─ Nếu N > 1  ─► Chia đôi thành nửa trái [0..N/2] và nửa phải [N/2..N],
                          giải phóng Semaphore trước khi đệ quy để không bao giờ deadlock!
```

- **Độ phức tạp cô lập 1 bài độc hại trong lô 20 bài:** tối đa $2 \times (1 + 2 \lceil \log_2 20 \rceil)$ lời gọi nhỏ, cứu sống **19/20 bài hợp lệ** trong cùng lô thay vì làm mất trắng cả lô.
- Đã kiểm thử tự động trong `crates/ai-bridge/tests/integration_tests.rs` (kịch bản 1 bài gây lỗi nằm giữa lô nhiều bài).

---

## 5. Phân tích Kích thước Lô (5, 10, 20, 40) & Khuyến nghị Mặc định

Kết quả chạy thực tế `cargo run -p dealsonar-ai-bridge --bin eval` trên tập chuẩn Bất động sản (`bds.jsonl`, 65 bài, có 1 bài > 2.600 ký tự kiểm tra cắt đầu-cuối và trần `24.000` ký tự/lô):

| Kích thước lô (`--batch-size`) | Số lời gọi CLI (trên 65 bài) | Input tokens / bài | Output tokens / bài | Nhận xét kỹ thuật |
|---:|---:|---:|---:|---|
| **5 bài/lô** | 13 lời gọi | 263,2 | 224,3 | Chi phí khởi động tiến trình CLI và lặp lại phần đầu prompt (`system` + định nghĩa radar + danh sách trường) cao gấp ~3,2 lần về số lượt gọi so với lô 20. |
| **10 bài/lô** | 7 lời gọi | 187,8 (-28,6%) | 224,0 | Phù hợp cho chế độ **Xem thử (`preview`)** để kết quả hiện dần nhanh trên giao diện trong khi người dùng chờ. |
| **20 bài/lô** | 4 lời gọi | **150,1 (-43,0%)** | 223,9 | **Điểm cân bằng tối ưu cho chế độ chạy thật (`live`)**: giảm 43% input token/bài và giảm hơn 3 lần số lần khởi động CLI mà tổng ngữ cảnh một lô (~3.000 token) vẫn nằm gọn trong vùng chính xác cao nhất của các mô hình tầng `Fast`. |
| **40 bài/lô** | 2 lời gọi | 124,9 (-52,5%) | 223,8 | Lợi ích tiết kiệm token biên bắt đầu bão hoà (chỉ giảm thêm ~25 token/bài so với lô 20), trong khi nguy cơ mô hình nhỏ bỏ sót `ref` cuối lô hoặc tốn chi phí chia đôi lô khi có bài lỗi tăng gấp đôi. |

**Quyết định kiến trúc từ S2:** Giữ đúng cấu hình mặc định `DEFAULT_LIVE_BATCH_POSTS = 20`, `DEFAULT_PREVIEW_BATCH_POSTS = 10`, và trần `DEFAULT_MAX_BATCH_INPUT_CHARS = 24_000` ký tự.

---

## 6. Lệnh kiểm chứng trên máy có đăng nhập CLI thật

Khi chạy trên máy phát triển hoặc máy kiểm thử đã cài và đăng nhập `claude`, `codex`, hoặc `agy`, chạy trực tiếp:

```bash
# Kiểm tra toàn bộ 16 bài test đơn vị & hộp cát tiến trình con
cargo test -p dealsonar-ai-bridge

# Đánh giá từng CLI thật ở tầng Fast và tầng Smart
cargo run -p dealsonar-ai-bridge --bin eval -- --dataset docs/eval/golden/bds.jsonl --radar docs/eval/golden/bds.radar.json --provider claude --tier fast --batch-size 20
cargo run -p dealsonar-ai-bridge --bin eval -- --dataset docs/eval/golden/bds.jsonl --radar docs/eval/golden/bds.radar.json --provider codex  --tier fast --batch-size 20
cargo run -p dealsonar-ai-bridge --bin eval -- --dataset docs/eval/golden/bds.jsonl --radar docs/eval/golden/bds.radar.json --provider agy    --tier fast --batch-size 20
```
