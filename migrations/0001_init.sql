CREATE TABLE pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
  latency_ms INTEGER
);

CREATE INDEX idx_pings_service_ts ON pings (service_id, timestamp DESC);
