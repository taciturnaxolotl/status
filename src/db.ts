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
	const row = await db
		.prepare(
			"SELECT COUNT(*) as total, SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) as up_count FROM pings WHERE service_id = ? AND timestamp >= ?",
		)
		.bind(service_id, since)
		.first<{ total: number; up_count: number }>();

	if (!row || row.total === 0) return 100;
	return Math.round((row.up_count / row.total) * 10000) / 100;
}

export async function getAllLatestPings(
	db: D1Database,
): Promise<Map<string, { status: string; latency_ms: number | null }>> {
	const rows = await db
		.prepare(
			`SELECT p.service_id, p.status, p.latency_ms
			FROM pings p
			INNER JOIN (SELECT service_id, MAX(timestamp) as max_ts FROM pings GROUP BY service_id) latest
			ON p.service_id = latest.service_id AND p.timestamp = latest.max_ts`,
		)
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

export async function getAllUptime7d(
	db: D1Database,
): Promise<Map<string, number>> {
	const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
	const rows = await db
		.prepare(
			`SELECT service_id, COUNT(*) as total, SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) as up_count
			FROM pings WHERE timestamp >= ?
			GROUP BY service_id`,
		)
		.bind(since)
		.all();

	const map = new Map<string, number>();
	for (const row of rows.results) {
		const total = row.total as number;
		const up = row.up_count as number;
		map.set(
			row.service_id as string,
			total === 0 ? 100 : Math.round((up / total) * 10000) / 100,
		);
	}
	return map;
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
				triage_report: row.triage_report as string | null,
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
				triage_report: row.triage_report as string | null,
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
