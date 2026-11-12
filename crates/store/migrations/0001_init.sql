-- 0001_init.sql
-- Initial DealSonar SQLite schema (04-data-model.md).
-- Tables are created in strict foreign-key dependency order.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);

CREATE TABLE channels (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                -- telegram | webhook
  name       TEXT NOT NULL,
  config     TEXT NOT NULL CHECK (json_valid(config)),
  state      TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL
);

CREATE TABLE contacts (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  phones       TEXT CHECK (phones IS NULL OR json_valid(phones)),
  author_ids   TEXT CHECK (author_ids IS NULL OR json_valid(author_ids)),
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE dup_clusters (
  id            TEXT PRIMARY KEY,
  head_post_id  TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 1,
  source_count  INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE authors (
  id             TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,
  external_id    TEXT,
  name           TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  post_count_7d  INTEGER NOT NULL DEFAULT 0,
  group_count_7d INTEGER NOT NULL DEFAULT 0,
  UNIQUE (platform, external_id)
);

CREATE TABLE sources (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL DEFAULT 'facebook',
  kind          TEXT NOT NULL DEFAULT 'group',
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  privacy       TEXT,                       -- public | private
  member_count  INTEGER,
  profile_id    TEXT,
  followed      INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'ok', -- ok | error | inaccessible
  last_crawl_at INTEGER,
  avg_new_posts REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE (platform, external_id)
);

CREATE TABLE crawl_runs (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,                -- scheduled | manual | preview | passive
  status     TEXT NOT NULL,                -- ok | empty | blocked | error
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  posts_seen INTEGER NOT NULL DEFAULT 0,
  posts_new  INTEGER NOT NULL DEFAULT 0,
  page_loads INTEGER NOT NULL DEFAULT 0,
  strategy   TEXT,
  error      TEXT
);
CREATE INDEX crawl_runs_source_time ON crawl_runs(source_id, started_at DESC);

CREATE TABLE posts (
  id               TEXT PRIMARY KEY,
  platform         TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  source_id        TEXT NOT NULL REFERENCES sources(id),
  author_id        TEXT REFERENCES authors(id) ON DELETE SET NULL,
  permalink        TEXT NOT NULL,
  text             TEXT,
  text_norm        TEXT,
  text_fold        TEXT,
  text_truncated   INTEGER NOT NULL DEFAULT 0,
  lang             TEXT,
  content_hash     TEXT NOT NULL,
  simhash          INTEGER NOT NULL,
  simhash_b0       INTEGER NOT NULL DEFAULT 0,
  simhash_b1       INTEGER NOT NULL DEFAULT 0,
  simhash_b2       INTEGER NOT NULL DEFAULT 0,
  simhash_b3       INTEGER NOT NULL DEFAULT 0,
  dup_cluster_id   TEXT REFERENCES dup_clusters(id) ON DELETE SET NULL,
  is_cluster_head  INTEGER NOT NULL DEFAULT 1,
  attachments      TEXT CHECK (attachments IS NULL OR json_valid(attachments)),
  counts           TEXT CHECK (counts IS NULL OR json_valid(counts)),
  extracted_phones TEXT CHECK (extracted_phones IS NULL OR json_valid(extracted_phones)),
  created_at       INTEGER,
  captured_at      INTEGER NOT NULL,
  strategy         TEXT NOT NULL,
  purged_at        INTEGER,
  UNIQUE (platform, external_id)
);
CREATE INDEX posts_source_time ON posts(source_id, captured_at DESC);
CREATE INDEX posts_hash ON posts(content_hash);
CREATE INDEX posts_cluster ON posts(dup_cluster_id);
CREATE INDEX posts_author_time ON posts(author_id, captured_at DESC);
CREATE INDEX posts_simhash_b0 ON posts(simhash_b0, captured_at DESC);
CREATE INDEX posts_simhash_b1 ON posts(simhash_b1, captured_at DESC);
CREATE INDEX posts_simhash_b2 ON posts(simhash_b2, captured_at DESC);
CREATE INDEX posts_simhash_b3 ON posts(simhash_b3, captured_at DESC);

CREATE VIRTUAL TABLE posts_fts USING fts5(
  text,
  content='posts',
  content_rowid='rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER posts_fts_au AFTER UPDATE OF text ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO posts_fts(rowid, text) VALUES (new.rowid, new.text);
END;

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
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
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

CREATE TABLE ai_calls (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  model            TEXT,
  task             TEXT NOT NULL,
  radar_version_id TEXT,
  item_count       INTEGER NOT NULL DEFAULT 1,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cost_usd         REAL,
  duration_ms      INTEGER NOT NULL,
  status           TEXT NOT NULL,
  error            TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX ai_calls_time ON ai_calls(created_at DESC);

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
  ruleset_id       TEXT REFERENCES rulesets(id) ON DELETE SET NULL,
  ai_call_id       TEXT REFERENCES ai_calls(id) ON DELETE SET NULL,
  is_preview       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  UNIQUE (post_id, radar_version_id, is_preview)
);
CREATE INDEX evaluations_pending ON evaluations(state, radar_version_id) WHERE state = 'pending_ai';
CREATE INDEX evaluations_version_time ON evaluations(radar_version_id, created_at DESC);

CREATE TABLE leads (
  id               TEXT PRIMARY KEY,
  radar_id         TEXT NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  radar_version_id TEXT NOT NULL REFERENCES radar_versions(id) ON DELETE CASCADE,
  post_id          TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  evaluation_id    TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  contact_id       TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'new',
  score            REAL NOT NULL,
  summary          TEXT NOT NULL,
  fields           TEXT NOT NULL CHECK (json_valid(fields)),
  also_seen_in     TEXT CHECK (also_seen_in IS NULL OR json_valid(also_seen_in)),
  notified_at      INTEGER,
  follow_up_at     INTEGER,
  note             TEXT,
  tags             TEXT CHECK (tags IS NULL OR json_valid(tags)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (radar_id, post_id)
);
CREATE INDEX leads_radar_time ON leads(radar_id, created_at DESC);
CREATE INDEX leads_status ON leads(status, created_at DESC);

CREATE VIRTUAL TABLE leads_fts USING fts5(
  summary,
  note,
  content='leads',
  content_rowid='rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER leads_fts_ai AFTER INSERT ON leads BEGIN
  INSERT INTO leads_fts(rowid, summary, note) VALUES (new.rowid, new.summary, new.note);
END;

CREATE TRIGGER leads_fts_ad AFTER DELETE ON leads BEGIN
  INSERT INTO leads_fts(leads_fts, rowid, summary, note) VALUES ('delete', old.rowid, old.summary, old.note);
END;

CREATE TRIGGER leads_fts_au AFTER UPDATE OF summary, note ON leads BEGIN
  INSERT INTO leads_fts(leads_fts, rowid, summary, note) VALUES ('delete', old.rowid, old.summary, old.note);
  INSERT INTO leads_fts(rowid, summary, note) VALUES (new.rowid, new.summary, new.note);
END;

CREATE TABLE lead_events (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  data       TEXT CHECK (data IS NULL OR json_valid(data)),
  created_at INTEGER NOT NULL
);
CREATE INDEX lead_events_lead_time ON lead_events(lead_id, created_at ASC);

CREATE TABLE feedback (
  id               TEXT PRIMARY KEY,
  evaluation_id    TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  radar_version_id TEXT NOT NULL,
  post_id          TEXT NOT NULL,
  label            TEXT NOT NULL,
  corrected_fields TEXT CHECK (corrected_fields IS NULL OR json_valid(corrected_fields)),
  post_text        TEXT NOT NULL,
  origin           TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX feedback_radar ON feedback(radar_version_id, created_at DESC);

CREATE TABLE blocklist (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                -- author | phone | keyword
  value      TEXT NOT NULL,
  radar_id   TEXT REFERENCES radars(id) ON DELETE CASCADE,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, value, radar_id)
);
CREATE UNIQUE INDEX blocklist_global_unique ON blocklist(kind, value) WHERE radar_id IS NULL;

CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  lead_id     TEXT REFERENCES leads(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL CHECK (json_valid(payload)),
  state       TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL,
  sent_at     INTEGER,
  remote_id   TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox(state, next_try_at) WHERE state = 'pending';

CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  dedup_key  TEXT,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  state      TEXT NOT NULL DEFAULT 'queued',
  attempts   INTEGER NOT NULL DEFAULT 0,
  run_at     INTEGER NOT NULL,
  locked_at  INTEGER,
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(state, run_at) WHERE state = 'queued';
CREATE UNIQUE INDEX jobs_dedup ON jobs(dedup_key) WHERE state IN ('queued', 'running');
