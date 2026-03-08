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
	data: { status?: string; triage_report?: string; resolved_at?: number },
): Promise<void> {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (data.status) { sets.push("status = ?"); values.push(data.status); }
	if (data.triage_report !== undefined) { sets.push("triage_report = ?"); values.push(data.triage_report); }
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
	const incidents = await getActiveIncidents(db);
	return Promise.all(
		incidents.map(async (incident) => {
			const updates = await db
				.prepare("SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at ASC")
				.bind(incident.id)
				.all();
			return { ...incident, updates: updates.results as unknown as IncidentUpdate[] };
		}),
	);
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
