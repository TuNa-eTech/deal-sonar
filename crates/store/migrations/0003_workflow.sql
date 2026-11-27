ALTER TABLE leads ADD COLUMN read_at INTEGER;
UPDATE leads SET read_at = updated_at WHERE status <> 'new';
-- Legacy viewed means read, not a separate sales stage.
UPDATE leads SET status = 'new' WHERE status = 'viewed';
CREATE INDEX idx_leads_read ON leads(read_at, created_at);
CREATE INDEX idx_leads_follow_up ON leads(follow_up_at) WHERE follow_up_at IS NOT NULL;
CREATE TABLE follow_up_deliveries (
 lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
 due_at INTEGER NOT NULL,
 delivered_at INTEGER NOT NULL
);
