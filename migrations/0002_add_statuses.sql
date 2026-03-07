-- Drop the old CHECK constraint and add new one with additional statuses
-- SQLite doesn't support ALTER CONSTRAINT, so we recreate the table
CREATE TABLE pings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'misconfigured', 'timeout', 'down', 'unknown')),
  latency_ms INTEGER
);

INSERT INTO pings_new SELECT * FROM pings;

DROP TABLE pings;

ALTER TABLE pings_new RENAME TO pings;

CREATE INDEX idx_pings_service_ts ON pings (service_id, timestamp DESC);
