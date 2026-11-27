# Mô hình dữ liệu

Trạng thái: nháp v0.1 · 2026-11-11

Một file SQLite, chế độ WAL, khoá ngoại bật. Mọi ID là ULID dạng chuỗi trừ khi ghi khác. Mọi thời điểm là mili giây Unix kiểu `INTEGER`. Cột JSON kiểu `TEXT` có ràng buộc `json_valid`.

## 1. Sơ đồ quan hệ

```
sources ──< radar_sources >── radars ──< radar_versions ──< rulesets
   │                            │               │
   │                            │               └──< evaluations >── posts ──> authors
   │                            │                         │            │
   └──< crawl_runs              │                         │            └──> dup_clusters
                                │                         ▼
                                └──────────────────────< leads ──< lead_events
                                                          │  ├──< feedback
                                                          │  └──< outbox ──> channels
                                                          └──> contacts (P1)

Độc lập: jobs · ai_calls · settings · blocklist · schema_migrations
```

## 2. Lược đồ

Các bảng dưới đây được nhóm theo chủ đề để dễ đọc, không theo thứ tự tạo. Một số khoá ngoại trỏ tới bảng định nghĩa ở phần sau (`posts` → `dup_clusters`, `evaluations` → `ai_calls`, `leads` → `contacts`); file migration phải tạo bảng được trỏ tới trước.

### 2.1 Nguồn và thu thập

```sql
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL DEFAULT 'facebook',
  kind          TEXT NOT NULL DEFAULT 'group',
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  privacy       TEXT,                       -- public | private
  member_count  INTEGER,
  profile_id    TEXT,                       -- profile Chrome đã thấy nguồn này
  followed      INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'ok', -- ok | error | inaccessible
  last_crawl_at INTEGER,
  avg_new_posts REAL NOT NULL DEFAULT 0,    -- trung bình bài mới mỗi lần quét, 24 giờ
  created_at    INTEGER NOT NULL,
  UNIQUE (platform, external_id)
);

CREATE TABLE crawl_runs (
  id          TEXT PRIMARY KEY,             -- run_id do extension sinh
  source_id   TEXT NOT NULL REFERENCES sources(id),
  reason      TEXT NOT NULL,                -- scheduled | manual | preview | passive
  status      TEXT NOT NULL,                -- ok | empty | blocked | error
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  posts_seen  INTEGER NOT NULL DEFAULT 0,
  posts_new   INTEGER NOT NULL DEFAULT 0,
  page_loads  INTEGER NOT NULL DEFAULT 0,
  strategy    TEXT,
  error       TEXT
);
CREATE INDEX crawl_runs_source_time ON crawl_runs(source_id, started_at DESC);
```

### 2.2 Bài và tác giả

```sql
CREATE TABLE authors (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  external_id   TEXT,                       -- có thể thiếu
  name          TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  post_count_7d INTEGER NOT NULL DEFAULT 0,
  group_count_7d INTEGER NOT NULL DEFAULT 0,
  UNIQUE (platform, external_id)
);

CREATE TABLE posts (
  id             TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,
  external_id    TEXT NOT NULL,             -- post_id của nền tảng
  source_id      TEXT NOT NULL REFERENCES sources(id),
  author_id      TEXT REFERENCES authors(id),
  permalink      TEXT NOT NULL,
  text           TEXT,                      -- NULL sau khi hết hạn lưu giữ
  text_norm      TEXT,                      -- đã chuẩn hoá NFC, gọn khoảng trắng
  text_fold      TEXT,                      -- chữ thường, bỏ dấu; dùng cho bộ luật
  text_truncated INTEGER NOT NULL DEFAULT 0,
  lang           TEXT,
  content_hash   TEXT NOT NULL,             -- SHA-256 của dạng rút gọn
  simhash        INTEGER NOT NULL,          -- 64 bit
  dup_cluster_id TEXT REFERENCES dup_clusters(id),
  is_cluster_head INTEGER NOT NULL DEFAULT 1,
  attachments    TEXT CHECK (attachments IS NULL OR json_valid(attachments)),
  counts         TEXT CHECK (counts IS NULL OR json_valid(counts)),
  created_at     INTEGER,                   -- giờ đăng; có thể thiếu
  captured_at    INTEGER NOT NULL,
  strategy       TEXT NOT NULL,
  purged_at      INTEGER,
  UNIQUE (platform, external_id)
);
CREATE INDEX posts_source_time ON posts(source_id, captured_at DESC);
CREATE INDEX posts_hash ON posts(content_hash);
CREATE INDEX posts_cluster ON posts(dup_cluster_id);

CREATE TABLE dup_clusters (
  id           TEXT PRIMARY KEY,
  head_post_id TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 1,
  source_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- Tìm toàn văn, không phân biệt dấu
CREATE VIRTUAL TABLE posts_fts USING fts5(
  text, content='posts', content_rowid='rowid',
  tokenize = "unicode61 remove_diacritics 2"
);
```

### 2.3 Radar

```sql
CREATE TABLE radars (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft | active | paused | archived
  template_id     TEXT,
  current_version INTEGER NOT NULL DEFAULT 1,
  notify          TEXT NOT NULL CHECK (json_valid(notify)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE radar_versions (
  id              TEXT PRIMARY KEY,
  radar_id        TEXT NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  description     TEXT NOT NULL,
  language_hint   TEXT,
  user_profession TEXT,
  fields          TEXT NOT NULL CHECK (json_valid(fields)),
  match_policy    TEXT NOT NULL CHECK (json_valid(match_policy)),
  created_at      INTEGER NOT NULL,
  UNIQUE (radar_id, version)
);

CREATE TABLE radar_sources (
  radar_id  TEXT NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY (radar_id, source_id)
);

CREATE TABLE rulesets (
  id               TEXT PRIMARY KEY,
  radar_version_id TEXT NOT NULL REFERENCES radar_versions(id) ON DELETE CASCADE,
  revision         INTEGER NOT NULL,
  state            TEXT NOT NULL,          -- candidate | shadow | active | retired
  origin           TEXT NOT NULL,          -- seed | compiled | user
  body             TEXT NOT NULL CHECK (json_valid(body)),
  metrics          TEXT CHECK (metrics IS NULL OR json_valid(metrics)),
  created_at       INTEGER NOT NULL,
  activated_at     INTEGER,
  UNIQUE (radar_version_id, revision)
);
```

### 2.4 Đánh giá, tin, phản hồi

```sql
-- Một dòng cho mỗi (bài, phiên bản radar). Ghi lại bài đã đi tới tầng nào và kết quả.
CREATE TABLE evaluations (
  id               TEXT PRIMARY KEY,
  post_id          TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  radar_version_id TEXT NOT NULL REFERENCES radar_versions(id) ON DELETE CASCADE,
  state            TEXT NOT NULL,  -- pending_ai | done | ai_failed
  decided_by       TEXT,           -- dedup | prefilter | rule | ai | postfilter
  verdict          TEXT,           -- match | no_match
  reject_reason    TEXT,           -- duplicate | prefilter | irrelevant | peer | spam | blocked | hard_filter
  score            REAL,
  intent           TEXT,
  author_role      TEXT,
  summary          TEXT,
  reason           TEXT,
  fields           TEXT CHECK (fields IS NULL OR json_valid(fields)),
  ruleset_id       TEXT REFERENCES rulesets(id),
  ai_call_id       TEXT REFERENCES ai_calls(id),
  is_preview       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  UNIQUE (post_id, radar_version_id, is_preview)
);
CREATE INDEX evaluations_pending ON evaluations(state, radar_version_id) WHERE state = 'pending_ai';

CREATE TABLE leads (
  id               TEXT PRIMARY KEY,
  radar_id         TEXT NOT NULL REFERENCES radars(id),
  radar_version_id TEXT NOT NULL REFERENCES radar_versions(id),
  post_id          TEXT NOT NULL REFERENCES posts(id),
  evaluation_id    TEXT NOT NULL REFERENCES evaluations(id),
  contact_id       TEXT REFERENCES contacts(id),
  status           TEXT NOT NULL DEFAULT 'new',
  score            REAL NOT NULL,
  summary          TEXT NOT NULL,
  fields           TEXT NOT NULL CHECK (json_valid(fields)),  -- bản sao sửa được của evaluations.fields
  also_seen_in     TEXT CHECK (also_seen_in IS NULL OR json_valid(also_seen_in)),
  notified_at      INTEGER,
  follow_up_at     INTEGER,                                   -- P1
  note             TEXT,                                      -- P1
  tags             TEXT CHECK (tags IS NULL OR json_valid(tags)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (radar_id, post_id)
);
CREATE INDEX leads_radar_time ON leads(radar_id, created_at DESC);
CREATE INDEX leads_status ON leads(status, created_at DESC);

CREATE VIRTUAL TABLE leads_fts USING fts5(
  summary, note, content='leads', content_rowid='rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TABLE lead_events (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,   -- created | status_changed | field_edited | notified | noted
  data       TEXT CHECK (data IS NULL OR json_valid(data)),
  created_at INTEGER NOT NULL
);

CREATE TABLE feedback (
  id               TEXT PRIMARY KEY,
  evaluation_id    TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  radar_version_id TEXT NOT NULL,
  post_id          TEXT NOT NULL,
  label            TEXT NOT NULL,  -- correct | irrelevant | wrong_fields | peer | duplicate | spam | missed
  corrected_fields TEXT CHECK (corrected_fields IS NULL OR json_valid(corrected_fields)),
  post_text        TEXT NOT NULL,  -- bản sao nội dung, sống qua việc dọn bài
  origin           TEXT NOT NULL,  -- app | telegram | preview
  created_at       INTEGER NOT NULL
);
CREATE INDEX feedback_radar ON feedback(radar_version_id, created_at DESC);
```

`feedback.label = 'missed'` dành cho trường hợp người dùng mở danh sách bài bị loại và chỉ ra một bài đáng lẽ phải khớp.

### 2.5 Danh bạ và chặn

```sql
CREATE TABLE contacts (                    -- P1
  id          TEXT PRIMARY KEY,
  display_name TEXT,
  phones      TEXT CHECK (phones IS NULL OR json_valid(phones)),  -- mảng E.164
  author_ids  TEXT CHECK (author_ids IS NULL OR json_valid(author_ids)),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE blocklist (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                -- author | phone | keyword
  value      TEXT NOT NULL,                -- author_id, SĐT E.164, hoặc từ khoá
  radar_id   TEXT REFERENCES radars(id) ON DELETE CASCADE,  -- NULL = mọi radar
  reason     TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, value, radar_id)
);
```

### 2.6 Vận hành

```sql
CREATE TABLE channels (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                -- telegram | webhook
  name       TEXT NOT NULL,
  config     TEXT NOT NULL CHECK (json_valid(config)),  -- chat_id, url… KHÔNG chứa token
  state      TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);

CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id),
  lead_id     TEXT REFERENCES leads(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,               -- lead | digest | system
  payload     TEXT NOT NULL CHECK (json_valid(payload)),
  state       TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | dropped
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL,
  sent_at     INTEGER,
  remote_id   TEXT,                        -- message_id của Telegram
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox(state, next_try_at) WHERE state = 'pending';

CREATE TABLE ai_calls (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,             -- claude_cli | codex_cli | agy_cli
  model         TEXT,
  task          TEXT NOT NULL,             -- suggest_fields | judge_extract | compile_rules
  radar_version_id TEXT,
  item_count    INTEGER NOT NULL DEFAULT 1,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,                      -- nếu CLI báo
  duration_ms   INTEGER NOT NULL,
  status        TEXT NOT NULL,             -- ok | invalid_output | timeout | rate_limited | error
  error         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX ai_calls_time ON ai_calls(created_at DESC);

CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  dedup_key  TEXT,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  state      TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  run_at     INTEGER NOT NULL,
  locked_at  INTEGER,
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(state, run_at) WHERE state = 'queued';
CREATE UNIQUE INDEX jobs_dedup ON jobs(dedup_key) WHERE state IN ('queued', 'running');

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
```

`ai_calls` không lưu prompt và phản hồi. Khi cần gỡ lỗi chất lượng, bật cờ `debug.keep_ai_io` trong cài đặt để ghi chúng ra file trong `logs/`, tự xoá sau 24 giờ.

## 3. Truy vấn trên trường động

Giá trị đã trích nằm trong `leads.fields` dạng JSON theo [Đặc tả radar §3.3](../product/02-radar-spec.md#33-giá-trị-đã-trích). Bộ lọc ở [Desktop §4](03-desktop.md#4-lệnh-cho-giao-diện) được dịch sang hàm JSON:

```sql
-- Tin của một radar có giá tối đa 15 triệu và quận thuộc danh sách
SELECT l.* FROM leads l
WHERE l.radar_id = :radar
  AND CAST(json_extract(l.fields, '$.price.value.max') AS INTEGER) <= 15000000
  AND json_extract(l.fields, '$.district.value.district') IN ('Cầu Giấy', 'Nam Từ Liêm')
ORDER BY l.created_at DESC
LIMIT 50;
```

Tên trường đi vào đường dẫn JSON phải được kiểm tra đối chiếu với định nghĩa trường của radar trước khi ghép vào câu truy vấn; không bao giờ ghép chuỗi người dùng nhập trực tiếp.

Khi một radar vượt khoảng 50.000 tin và một trường được lọc thường xuyên, thêm chỉ mục biểu thức cho trường đó. Chưa cần trong MVP.

## 4. Bí mật

Không bí mật nào nằm trong SQLite.

| Bí mật | Nơi lưu |
|---|---|
| Token bot Telegram | Kho khoá hệ điều hành, dịch vụ `DealSonar`, tài khoản `telegram:<channel_id>` |
| Bí mật ký webhook (P1) | Kho khoá hệ điều hành |
| Khoá bản quyền | Bảng `settings` (không phải bí mật: đã ký, không chứa thông tin nhạy cảm) |
| Đăng nhập AI | Do từng CLI tự quản; DealSonar không đọc, không lưu |

## 5. Lưu giữ và dọn dẹp

Công việc `purge_expired` chạy hằng ngày.

| Dữ liệu | Giữ bao lâu | Khi hết hạn |
|---|---|---|
| Bài có tin gắn với nó | Tới khi người dùng xoá tin | |
| Bài không khớp radar nào | 30 ngày (D-6, chỉnh được 7–90) | Đặt `text`, `text_norm`, `text_fold`, `attachments` thành NULL; giữ `content_hash`, `simhash` để còn lọc trùng; ghi `purged_at` |
| Đánh giá của bài đã dọn | Giữ dòng, xoá `summary`, `reason`, `fields` | |
| Phản hồi | Tới khi người dùng xoá radar | |
| `crawl_runs`, `ai_calls` | 90 ngày | Xoá dòng |
| `jobs` đã xong, `outbox` đã gửi | 14 ngày | Xoá dòng |
| Tác giả không còn bài nào giữ nội dung | | Xoá dòng |

"Xoá toàn bộ dữ liệu" trong Cài đặt xoá file cơ sở dữ liệu, các bản sao lưu, nhật ký và mục trong kho khoá.

## 6. Migration

- File SQL đánh số trong `crates/store/migrations/NNNN_tên.sql`, chạy trong giao dịch, ghi vào `schema_migrations`.
- Chỉ đi tới; không có migration lùi. Trước mỗi migration thay đổi cấu trúc bảng có dữ liệu, app sao lưu file vào `backups/`.
- App từ chối mở cơ sở dữ liệu có phiên bản lược đồ mới hơn nó biết, và hướng dẫn người dùng cập nhật app.

## 7. Ước lượng dung lượng

Giả định một bài trung bình 600 byte nội dung; ba bản (`text`, `text_norm`, `text_fold`) cộng chỉ mục FTS khoảng 3 KB mỗi bài còn giữ nội dung.

| Cấu hình | Bài mỗi ngày | Giữ nội dung (30 ngày) | Sau một năm (tính cả dòng đã dọn) |
|---|---|---|---|
| 10 group, mỗi group 100 bài/ngày | 1.000 | ~90 MB | ~150 MB |
| 50 group, mỗi group 300 bài/ngày | 15.000 | ~1,4 GB | ~2,5 GB |

Cấu hình thứ hai gợi ý nên bỏ cột `text_norm` (tính lại được từ `text`) nếu dung lượng thành vấn đề. Các con số là ước tính trên giấy, cần đo.
