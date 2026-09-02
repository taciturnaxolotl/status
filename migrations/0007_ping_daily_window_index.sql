-- ping_daily's primary key is (service_id, day_bucket, status). Because
-- service_id leads, a `day_bucket >= ?` filter cannot seek, so every windowed
-- aggregate fell back to SCAN and read the whole table -- a cost that grows
-- forever, since daily rollups are never pruned.
--
-- Leading with day_bucket lets those queries seek to the window, and carrying
-- status and count makes them index-only.
CREATE INDEX idx_ping_daily_window ON ping_daily (day_bucket, service_id, status, count);

-- Subsumed by the index above, whose leading column is also day_bucket.
DROP INDEX idx_ping_daily_bucket;
