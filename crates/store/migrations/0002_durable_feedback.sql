-- Feedback is durable training data. The evaluation ID is an audit reference,
-- not an ownership relation: deleting temporary preview rows must retain it.
CREATE TABLE feedback_v2 (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL,
  radar_version_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  label TEXT NOT NULL,
  corrected_fields TEXT CHECK (corrected_fields IS NULL OR json_valid(corrected_fields)),
  post_text TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expected_match INTEGER NOT NULL CHECK (expected_match IN (0, 1))
);
INSERT INTO feedback_v2
SELECT f.*, CASE
  WHEN f.label = 'correct' THEN COALESCE(e.verdict = 'match', 1)
  WHEN f.label IN ('missed', 'wrong_fields') THEN 1
  ELSE 0 END
FROM feedback f LEFT JOIN evaluations e ON e.id = f.evaluation_id;
DROP TABLE feedback;
ALTER TABLE feedback_v2 RENAME TO feedback;
CREATE INDEX feedback_radar ON feedback(radar_version_id, created_at DESC);
