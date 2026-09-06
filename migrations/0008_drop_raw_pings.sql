-- Every read path serves from the rollups, so `pings` had no readers left: it
-- was 22k of the 39k rows written per day (57% of the budget) to maintain a
-- table nothing queried. One insert plus three index entries per check, and the
-- 30-day prune paying the same cost again on the way out.
--
-- The rollups are the record now. ping_daily is kept forever, ping_hourly for
-- 90 days, and service_latest holds the current state.
DROP TABLE pings;
