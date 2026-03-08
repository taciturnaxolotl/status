export async function insertPing(
	db: D1Database,
	service_id: string,
	status: string,
	latency_ms: number,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO pings (service_id, timestamp, status, latency_ms) VALUES (?, ?, ?, ?)",
		)
		.bind(service_id, Math.floor(Date.now() / 1000), status, latency_ms)
		.run();
}

export async function getLatestPing(
	db: D1Database,
	service_id: string,
): Promise<{ status: string; latency_ms: number | null } | null> {
	const row = await db
		.prepare(
			"SELECT status, latency_ms FROM pings WHERE service_id = ? ORDER BY timestamp DESC LIMIT 1",
		)
		.bind(service_id)
		.first();
	if (!row) return null;
	return { status: row.status as string, latency_ms: row.latency_ms as number | null };
}

export async function getUptime7d(
	db: D1Database,
	service_id: string,
): Promise<number> {
	const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
	const total = await db
		.prepare(
			"SELECT COUNT(*) as count FROM pings WHERE service_id = ? AND timestamp >= ?",
		)
		.bind(service_id, since)
		.first<{ count: number }>();
	const up = await db
		.prepare(
			"SELECT COUNT(*) as count FROM pings WHERE service_id = ? AND timestamp >= ? AND status = 'up'",
		)
		.bind(service_id, since)
		.first<{ count: number }>();

	if (!total || total.count === 0) return 100;
	return Math.round(((up?.count ?? 0) / total.count) * 10000) / 100;
}

export async function getUptimeBuckets(
	db: D1Database,
	service_id: string,
	window_hours: number,
): Promise<{ timestamp: number; status: "up" | "degraded" | "down" }[]> {
	const since = Math.floor(Date.now() / 1000) - window_hours * 60 * 60;
	const rows = await db
		.prepare(
			`SELECT
				(timestamp / 3600) * 3600 AS bucket,
				status,
				COUNT(*) AS cnt
			FROM pings
			WHERE service_id = ? AND timestamp >= ?
			GROUP BY bucket, status
			ORDER BY bucket ASC`,
		)
		.bind(service_id, since)
		.all();

	const bucketMap = new Map<number, Map<string, number>>();
	for (const row of rows.results) {
		const b = row.bucket as number;
		if (!bucketMap.has(b)) bucketMap.set(b, new Map());
		bucketMap.get(b)!.set(row.status as string, row.cnt as number);
	}

	const result: { timestamp: number; status: "up" | "degraded" | "down" }[] = [];
	for (const [bucket, counts] of bucketMap) {
		let status: "up" | "degraded" | "down" = "up";
		if (counts.has("down")) status = "down";
		else if (counts.has("degraded")) status = "degraded";
		result.push({ timestamp: bucket, status });
	}

	return result;
}

export async function getOverallUptimeDays(
	db: D1Database,
	days: number,
): Promise<{ date: string; status: "up" | "degraded" | "down" | "none" }[]> {
	const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
	const rows = await db
		.prepare(
			`SELECT
				(timestamp / 86400) AS day_bucket,
				status,
				COUNT(*) AS cnt
			FROM pings
			WHERE timestamp >= ?
			GROUP BY day_bucket, status
			ORDER BY day_bucket ASC`,
		)
		.bind(since)
		.all();

	const bucketMap = new Map<number, Map<string, number>>();
	for (const row of rows.results) {
		const b = row.day_bucket as number;
		if (!bucketMap.has(b)) bucketMap.set(b, new Map());
		bucketMap.get(b)!.set(row.status as string, row.cnt as number);
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

		let status: "up" | "degraded" | "down" = "up";
		if (counts.has("down") || counts.has("timeout")) status = "down";
		else if (counts.has("degraded") || counts.has("misconfigured")) status = "degraded";

		result.push({ date, status });
	}

	return result;
}

export async function getLastCheckTime(
	db: D1Database,
): Promise<number | null> {
	const row = await db
		.prepare("SELECT MAX(timestamp) as ts FROM pings")
		.first<{ ts: number | null }>();
	return row?.ts ?? null;
}

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
