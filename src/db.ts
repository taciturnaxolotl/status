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

import type { Incident, IncidentUpdate, IncidentWithUpdates } from "./types";

export async function createIncident(
	db: D1Database,
	data: { service_id: string; title: string; severity: "critical" | "major" | "minor"; github_repo?: string; github_issue_number?: number },
): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	const result = await db
		.prepare(
			"INSERT INTO incidents (service_id, title, status, severity, github_repo, github_issue_number, started_at, created_at, updated_at) VALUES (?, ?, 'investigating', ?, ?, ?, ?, ?, ?)",
		)
		.bind(data.service_id, data.title, data.severity, data.github_repo ?? null, data.github_issue_number ?? null, now, now, now)
		.run();
	const id = result.meta.last_row_id;
	await db
		.prepare(
			"INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, 'investigating', 'Incident detected automatically', ?)",
		)
		.bind(id, now)
		.run();
	return id as number;
}

export async function updateIncident(
	db: D1Database,
	id: number,
	data: { status?: string; resolved_at?: number },
): Promise<void> {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (data.status) { sets.push("status = ?"); values.push(data.status); }
	if (data.resolved_at) { sets.push("resolved_at = ?"); values.push(data.resolved_at); }
	sets.push("updated_at = ?");
	values.push(Math.floor(Date.now() / 1000));
	values.push(id);
	await db
		.prepare(`UPDATE incidents SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();
}

export async function addIncidentUpdate(
	db: D1Database,
	incident_id: number,
	status: string,
	message: string,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db
		.prepare("INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)")
		.bind(incident_id, status, message, now)
		.run();
}

export async function getActiveIncidents(db: D1Database): Promise<Incident[]> {
	const rows = await db
		.prepare("SELECT * FROM incidents WHERE status != 'resolved' ORDER BY created_at DESC")
		.all();
	return rows.results as unknown as Incident[];
}

export async function getActiveIncidentsWithUpdates(db: D1Database): Promise<IncidentWithUpdates[]> {
	const rows = await db
		.prepare(
			`SELECT i.*, u.id as update_id, u.status as update_status, u.message as update_message, u.created_at as update_created_at
			FROM incidents i
			LEFT JOIN incident_updates u ON u.incident_id = i.id
			WHERE i.status != 'resolved'
			ORDER BY i.created_at DESC, u.created_at ASC`,
		)
		.all();

	const incidentMap = new Map<number, IncidentWithUpdates>();
	for (const row of rows.results) {
		const id = row.id as number;
		if (!incidentMap.has(id)) {
			incidentMap.set(id, {
				id,
				service_id: row.service_id as string,
				title: row.title as string,
				status: row.status as string,
				severity: row.severity as string,
				github_repo: row.github_repo as string | null,
				github_issue_number: row.github_issue_number as number | null,
				started_at: row.started_at as number,
				resolved_at: row.resolved_at as number | null,
				created_at: row.created_at as number,
				updated_at: row.updated_at as number,
				updates: [],
			});
		}
		if (row.update_id) {
			incidentMap.get(id)!.updates.push({
				id: row.update_id as number,
				incident_id: id,
				status: row.update_status as string,
				message: row.update_message as string,
				created_at: row.update_created_at as number,
			});
		}
	}
	return Array.from(incidentMap.values());
}

export async function getActiveIncidentForService(
	db: D1Database,
	service_id: string,
): Promise<Incident | null> {
	const row = await db
		.prepare("SELECT * FROM incidents WHERE service_id = ? AND status != 'resolved' ORDER BY created_at DESC LIMIT 1")
		.bind(service_id)
		.first();
	return (row as unknown as Incident) ?? null;
}

export async function getRecentIncidents(db: D1Database, days: number): Promise<Incident[]> {
	const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
	const rows = await db
		.prepare("SELECT * FROM incidents WHERE resolved_at >= ? OR status != 'resolved' ORDER BY created_at DESC")
		.bind(since)
		.all();
	return rows.results as unknown as Incident[];
}

export async function getRecentResolvedIncidentsWithUpdates(db: D1Database, days: number): Promise<IncidentWithUpdates[]> {
	const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
	const rows = await db
		.prepare(
			`SELECT i.*, u.id as update_id, u.status as update_status, u.message as update_message, u.created_at as update_created_at
			FROM incidents i
			LEFT JOIN incident_updates u ON u.incident_id = i.id
			WHERE i.status = 'resolved' AND i.resolved_at >= ?
			ORDER BY i.resolved_at DESC, u.created_at ASC`,
		)
		.bind(since)
		.all();

	const incidentMap = new Map<number, IncidentWithUpdates>();
	for (const row of rows.results) {
		const id = row.id as number;
		if (!incidentMap.has(id)) {
			incidentMap.set(id, {
				id,
				service_id: row.service_id as string,
				title: row.title as string,
				status: row.status as string,
				severity: row.severity as string,
				github_repo: row.github_repo as string | null,
				github_issue_number: row.github_issue_number as number | null,
				started_at: row.started_at as number,
				resolved_at: row.resolved_at as number | null,
				created_at: row.created_at as number,
				updated_at: row.updated_at as number,
				updates: [],
			});
		}
		if (row.update_id) {
			incidentMap.get(id)!.updates.push({
				id: row.update_id as number,
				incident_id: id,
				status: row.update_status as string,
				message: row.update_message as string,
				created_at: row.update_created_at as number,
			});
		}
	}
	return Array.from(incidentMap.values());
}

export async function getIncident(db: D1Database, id: number): Promise<IncidentWithUpdates | null> {
	const incident = await db
		.prepare("SELECT * FROM incidents WHERE id = ?")
		.bind(id)
		.first();
	if (!incident) return null;
	const updates = await db
		.prepare("SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at ASC")
		.bind(id)
		.all();
	return {
		...(incident as unknown as Incident),
		updates: updates.results as unknown as IncidentUpdate[],
	};
}

export async function getIncidentByGitHubIssue(
	db: D1Database,
	repo: string,
	issueNumber: number,
): Promise<Incident | null> {
	const row = await db
		.prepare("SELECT * FROM incidents WHERE github_repo = ? AND github_issue_number = ? LIMIT 1")
		.bind(repo, issueNumber)
		.first();
	return (row as unknown as Incident) ?? null;
}

export async function setIncidentGitHub(
	db: D1Database,
	id: number,
	repo: string,
	issueNumber: number,
): Promise<void> {
	await db
		.prepare("UPDATE incidents SET github_repo = ?, github_issue_number = ?, updated_at = ? WHERE id = ?")
		.bind(repo, issueNumber, Math.floor(Date.now() / 1000), id)
		.run();
}

export async function getRecentlyResolvedIncident(
	db: D1Database,
	service_id: string,
	withinSeconds: number,
): Promise<Incident | null> {
	const since = Math.floor(Date.now() / 1000) - withinSeconds;
	const row = await db
		.prepare("SELECT * FROM incidents WHERE service_id = ? AND status = 'resolved' AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 1")
		.bind(service_id, since)
		.first();
	return (row as unknown as Incident) ?? null;
}

export async function getRecentlyResolvedIncidents(
	db: D1Database,
	withinSeconds: number,
): Promise<Incident[]> {
	const since = Math.floor(Date.now() / 1000) - withinSeconds;
	const rows = await db
		.prepare("SELECT * FROM incidents WHERE status = 'resolved' AND resolved_at >= ? ORDER BY resolved_at DESC")
		.bind(since)
		.all();
	return rows.results as unknown as Incident[];
}
