/**
 * Record one health check.
 *
 * Writes the raw ping plus the three derived rows every read path uses, in a
 * single batch. 4 rows written per check instead of 1, which is what buys us
 * reads measured in hundreds instead of millions.
 */
export async function recordPing(
	db: D1Database,
	service_id: string,
	status: string,
	latency_ms: number,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);

	await db.batch([
		db
			.prepare(
				"INSERT INTO pings (service_id, timestamp, status, latency_ms) VALUES (?, ?, ?, ?)",
			)
			.bind(service_id, now, status, latency_ms),
		db
			.prepare(
				`INSERT INTO service_latest (service_id, status, latency_ms, timestamp)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(service_id) DO UPDATE SET
					status = excluded.status,
					latency_ms = excluded.latency_ms,
					timestamp = excluded.timestamp`,
			)
			.bind(service_id, status, latency_ms, now),
		db
			.prepare(
				`INSERT INTO ping_hourly (service_id, hour_bucket, status, count) VALUES (?, ?, ?, 1)
				ON CONFLICT(service_id, hour_bucket, status) DO UPDATE SET count = count + 1`,
			)
			.bind(service_id, Math.floor(now / 3600), status),
		db
			.prepare(
				`INSERT INTO ping_daily (service_id, day_bucket, status, count) VALUES (?, ?, ?, 1)
				ON CONFLICT(service_id, day_bucket, status) DO UPDATE SET count = count + 1`,
			)
			.bind(service_id, Math.floor(now / 86400), status),
	]);
}

// Reads 1 row instead of scanning the service's slice of `pings`.
export async function getLatestPing(
	db: D1Database,
	service_id: string,
): Promise<{ status: string; latency_ms: number | null } | null> {
	const row = await db
		.prepare("SELECT status, latency_ms FROM service_latest WHERE service_id = ?")
		.bind(service_id)
		.first();
	if (!row) return null;
	return { status: row.status as string, latency_ms: row.latency_ms as number | null };
}

// Reads one row per service instead of a GROUP BY over the whole table.
export async function getAllLatestPings(
	db: D1Database,
): Promise<Map<string, { status: string; latency_ms: number | null }>> {
	const rows = await db
		.prepare("SELECT service_id, status, latency_ms FROM service_latest")
		.all();

	const map = new Map<string, { status: string; latency_ms: number | null }>();
	for (const row of rows.results) {
		map.set(row.service_id as string, {
			status: row.status as string,
			latency_ms: row.latency_ms as number | null,
		});
	}
	return map;
}

// Daily rollups only align to day boundaries, so a window covers `days` whole
// days rather than the old rolling now - days * 86400 cutoff.
function dayBucketSince(days: number): number {
	return Math.floor(Math.floor(Date.now() / 1000) / 86400) - (days - 1);
}

function serviceFilter(serviceIds?: string[]): { clause: string; params: string[] } {
	if (!serviceIds || serviceIds.length === 0) return { clause: "", params: [] };
	const placeholders = serviceIds.map(() => "?").join(", ");
	return { clause: ` AND service_id IN (${placeholders})`, params: serviceIds };
}

// ~90 rows read (one per day) instead of the service's 90-day ping slice.
export async function getUptime7d(
	db: D1Database,
	service_id: string,
	days = 90,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT
				SUM(count) AS total,
				SUM(CASE WHEN status = 'up' THEN count ELSE 0 END) AS up_count
			FROM ping_daily WHERE service_id = ? AND day_bucket >= ?`,
		)
		.bind(service_id, dayBucketSince(days))
		.first<{ total: number | null; up_count: number | null }>();

	if (!row || !row.total) return 100;
	return Math.round(((row.up_count ?? 0) / row.total) * 10000) / 100;
}

// ~90 x services rows (~1.5k) instead of ~427k.
export async function getAllUptime7d(
	db: D1Database,
	days = 90,
): Promise<Map<string, number>> {
	const rows = await db
		.prepare(
			`SELECT service_id,
				SUM(count) AS total,
				SUM(CASE WHEN status = 'up' THEN count ELSE 0 END) AS up_count
			FROM ping_daily WHERE day_bucket >= ?
			GROUP BY service_id`,
		)
		.bind(dayBucketSince(days))
		.all();

	const map = new Map<string, number>();
	for (const row of rows.results) {
		const total = row.total as number;
		const up = row.up_count as number;
		map.set(
			row.service_id as string,
			!total ? 100 : Math.round((up / total) * 10000) / 100,
		);
	}
	return map;
}

// Reads pre-aggregated hourly buckets. Raw pings are pruned at 30 days, so this
// is also the only thing that can still answer a 90-day window.
export async function getUptimeBuckets(
	db: D1Database,
	service_id: string,
	window_hours: number,
): Promise<{ timestamp: number; status: "up" | "degraded" | "down" }[]> {
	const sinceBucket = Math.floor(Math.floor(Date.now() / 1000) / 3600) - window_hours;
	const rows = await db
		.prepare(
			`SELECT hour_bucket,
				SUM(CASE WHEN status = 'down' THEN count ELSE 0 END) AS down_count,
				SUM(CASE WHEN status = 'degraded' THEN count ELSE 0 END) AS degraded_count
			FROM ping_hourly
			WHERE service_id = ? AND hour_bucket >= ?
			GROUP BY hour_bucket
			ORDER BY hour_bucket ASC`,
		)
		.bind(service_id, sinceBucket)
		.all();

	return rows.results.map((row) => {
		let status: "up" | "degraded" | "down" = "up";
		if ((row.down_count as number) > 0) status = "down";
		else if ((row.degraded_count as number) > 0) status = "degraded";
		return { timestamp: (row.hour_bucket as number) * 3600, status };
	});
}

// ~1.5k rows instead of ~427k.
export async function getOverallUptimeDays(
	db: D1Database,
	days: number,
	serviceIds?: string[],
): Promise<{ date: string; status: "up" | "degraded" | "down" | "none" }[]> {
	const filter = serviceFilter(serviceIds);
	const rows = await db
		.prepare(
			`SELECT
				day_bucket,
				service_id,
				SUM(count) AS total,
				SUM(CASE WHEN status IN ('down','timeout') THEN count ELSE 0 END) AS bad_count,
				SUM(CASE WHEN status IN ('degraded','misconfigured') THEN count ELSE 0 END) AS degraded_count
			FROM ping_daily
			WHERE day_bucket >= ?${filter.clause}
			GROUP BY day_bucket, service_id
			ORDER BY day_bucket ASC`,
		)
		.bind(dayBucketSince(days), ...filter.params)
		.all();

	// day_bucket -> { totalPings, totalBad, anyServiceReallyBad, anyServiceReallyDegraded }
	const bucketMap = new Map<number, { total: number; bad: number; reallyBad: boolean; reallyDegraded: boolean }>();
	for (const row of rows.results) {
		const b = row.day_bucket as number;
		if (!bucketMap.has(b)) bucketMap.set(b, { total: 0, bad: 0, reallyBad: false, reallyDegraded: false });
		const bucket = bucketMap.get(b)!;
		const badCount = row.bad_count as number;
		const degradedCount = row.degraded_count as number;
		bucket.total += row.total as number;
		bucket.bad += badCount;
		// A service counts as "really" bad/degraded only if it failed ≥2 checks,
		// matching the 2-consecutive-failures threshold used by the incident system.
		if (badCount >= 2) bucket.reallyBad = true;
		if (degradedCount >= 2) bucket.reallyDegraded = true;
	}

	const now = Math.floor(Date.now() / 1000);
	const todayBucket = Math.floor(now / 86400);
	const result: { date: string; status: "up" | "degraded" | "down" | "none" }[] = [];

	for (let i = days - 1; i >= 0; i--) {
		const bucket = todayBucket - i;
		const d = new Date(bucket * 86400 * 1000);
		const date = d.toISOString().slice(0, 10);
		const counts = bucketMap.get(bucket);

		if (!counts) {
			result.push({ date, status: "none" });
			continue;
		}

		const badRatio = counts.total > 0 ? counts.bad / counts.total : 0;

		let status: "up" | "degraded" | "down" = "up";
		if (badRatio > 0.05) status = "down";
		else if (counts.reallyBad || counts.reallyDegraded) status = "degraded";

		result.push({ date, status });
	}

	return result;
}

// ~1.5k rows instead of ~427k.
export async function getOverallUptimePct(
	db: D1Database,
	days: number,
	serviceIds?: string[],
): Promise<number> {
	const filter = serviceFilter(serviceIds);
	const row = await db
		.prepare(
			`SELECT
				SUM(count) AS total,
				SUM(CASE WHEN status NOT IN ('down','timeout') THEN count ELSE 0 END) AS up_count
			FROM ping_daily
			WHERE day_bucket >= ?${filter.clause}`,
		)
		.bind(dayBucketSince(days), ...filter.params)
		.first<{ up_count: number | null; total: number | null }>();

	if (!row || !row.total) return 100;
	return Math.round(((row.up_count ?? 0) / row.total) * 10000) / 100;
}

// One row per service instead of MAX() over the whole pings table.
export async function getLastCheckTime(
	db: D1Database,
): Promise<number | null> {
	const row = await db
		.prepare("SELECT MAX(timestamp) as ts FROM service_latest")
		.first<{ ts: number | null }>();
	return row?.ts ?? null;
}

/**
 * Raw pings only back debugging of recent history now that every UI path reads
 * the rollups, so retention drops from 365d to 30d. At ~4.7k pings/day that
 * caps the table at ~140k rows instead of ~1.7M.
 */
export async function pruneOldPings(
	db: D1Database,
	days: number,
): Promise<void> {
	const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
	await db
		.prepare("DELETE FROM pings WHERE timestamp < ?")
		.bind(cutoff)
		.run();
}

/** Hourly buckets only back the 90-day uptime view; daily rollups are kept forever. */
export async function pruneOldHourly(
	db: D1Database,
	days: number,
): Promise<void> {
	const cutoff = Math.floor(Math.floor(Date.now() / 1000) / 3600) - days * 24;
	await db
		.prepare("DELETE FROM ping_hourly WHERE hour_bucket < ?")
		.bind(cutoff)
		.run();
}
