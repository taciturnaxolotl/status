-- Rollup tables. Every read path serves from these instead of scanning `pings`.
--
-- One row per (service, bucket, status), so recording a ping is a single static
-- upsert and the read queries keep the same shape they had against `pings`.
--
-- Both grains are kept on purpose: `ping_daily` is what the cron aggregates
-- every tick, and 90 days of hourly would be ~35k rows a tick (~10M/day), which
-- is the budget this whole change exists to protect.

CREATE TABLE service_latest (
  service_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  timestamp INTEGER NOT NULL
);

CREATE TABLE ping_hourly (
  service_id TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  status TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, hour_bucket, status)
);

CREATE INDEX idx_ping_hourly_bucket ON ping_hourly (hour_bucket);

CREATE TABLE ping_daily (
  service_id TEXT NOT NULL,
  day_bucket INTEGER NOT NULL,
  status TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, day_bucket, status)
);

CREATE INDEX idx_ping_daily_bucket ON ping_daily (day_bucket);

-- Backfill from history. These three scan `pings` once each, one time only.

INSERT INTO service_latest (service_id, status, latency_ms, timestamp)
SELECT service_id, status, latency_ms, timestamp FROM (
  SELECT service_id, status, latency_ms, timestamp,
         ROW_NUMBER() OVER (PARTITION BY service_id ORDER BY timestamp DESC, id DESC) AS rn
  FROM pings
) WHERE rn = 1;

INSERT INTO ping_hourly (service_id, hour_bucket, status, count)
SELECT service_id, timestamp / 3600, status, COUNT(*)
FROM pings GROUP BY service_id, timestamp / 3600, status;

INSERT INTO ping_daily (service_id, day_bucket, status, count)
SELECT service_id, timestamp / 86400, status, COUNT(*)
FROM pings GROUP BY service_id, timestamp / 86400, status;
