import type { Env } from "../types";
import { getManifest } from "../manifest";
import { getSnapshot } from "../snapshot";
import { getOverallStatus } from "../overall";

// Every route here serves from the KV snapshot, so a browser tab polling
// /api/status every 5 minutes costs zero D1 rows.
const CACHE_HEADERS = { "Cache-Control": "public, max-age=60" };

function worstStatus(statuses: string[]): string {
	if (statuses.length === 0) return "unknown";
	if (statuses.every((s) => s === "down" || s === "timeout")) return "down";
	if (statuses.includes("down") || statuses.includes("timeout")) return "partial";
	if (statuses.includes("misconfigured")) return "degraded";
	if (statuses.includes("degraded")) return "degraded";
	if (statuses.includes("unknown")) return "unknown";
	return "up";
}

// GET /api/status/overall
async function overallStatus(env: Env): Promise<Response> {
	const [manifest, snapshot] = await Promise.all([
		getManifest(env),
		getSnapshot(env),
	]);
	const allServices = Object.values(manifest).flatMap((m) => m.services);
	const monitored = allServices.filter((s) => s.health_url !== null);

	let totalUptime = 0;
	for (const svc of monitored) {
		totalUptime += snapshot.uptime90[svc.name] ?? 100;
	}

	const { grade } = getOverallStatus(manifest, snapshot, snapshot.active_incidents);
	const avgUptime =
		monitored.length > 0
			? Math.round((totalUptime / monitored.length) * 100) / 100
			: 100;

	return Response.json(
		{
			ok: grade === "up",
			status: grade,
			uptime_90d: avgUptime,
			services_total: allServices.length,
			services_monitored: monitored.length,
			machines_total: Object.keys(manifest).length,
		},
		{ headers: CACHE_HEADERS },
	);
}

// GET /api/status
async function fullStatus(env: Env): Promise<Response> {
	const [manifest, snapshot] = await Promise.all([
		getManifest(env),
		getSnapshot(env),
	]);
	const machines = Object.entries(manifest).map(([name, machine]) => {
		const online = snapshot.machine_online[name] ?? false;
		const services = machine.services.map((svc) => {
			const ping = snapshot.latest[svc.name];
			return {
				id: svc.name,
				status: (ping?.status ?? "unknown") as string,
				latency_ms: ping?.latency_ms ?? null,
				uptime_90d: snapshot.uptime90[svc.name] ?? 100,
			};
		});
		const svcStatuses = services.map((s) => s.status);
		return {
			name,
			hostname: machine.hostname,
			type: machine.type,
			online,
			status: online
			? svcStatuses.length > 0 ? worstStatus(svcStatuses) : "up"
			: "down",
			services,
		};
	});

	const { grade } = getOverallStatus(manifest, snapshot, snapshot.active_incidents);

	return Response.json(
		{
			ok: grade === "up",
			status: grade,
			last_check: snapshot.last_check,
			machines,
		},
		{ headers: CACHE_HEADERS },
	);
}

// GET /api/status/service/:id
async function serviceStatus(env: Env, id: string): Promise<Response> {
	const snapshot = await getSnapshot(env);
	const ping = snapshot.latest[id] ?? null;
	const uptime = snapshot.uptime90[id] ?? 100;

	if (!ping) {
		return Response.json({ error: "service not found" }, { status: 404 });
	}

	return Response.json(
		{
			id,
			status: ping.status,
			latency_ms: ping.latency_ms,
			uptime_90d: uptime,
		},
		{ headers: CACHE_HEADERS },
	);
}

// GET /api/status/machine/:name
async function machineStatus(env: Env, name: string): Promise<Response> {
	const [manifest, snapshot] = await Promise.all([
		getManifest(env),
		getSnapshot(env),
	]);
	const machine = manifest[name];

	if (!machine) {
		return Response.json({ error: "machine not found" }, { status: 404 });
	}

	const online = snapshot.machine_online[name] ?? false;
	const services = machine.services.map((svc) => {
		const ping = snapshot.latest[svc.name];
		return {
			id: svc.name,
			status: (ping?.status ?? "unknown") as string,
			latency_ms: ping?.latency_ms ?? null,
			uptime_90d: snapshot.uptime90[svc.name] ?? 100,
		};
	});

	const statuses = services.map((s) => s.status);
	const status = online ? worstStatus(statuses) : "down";

	return Response.json(
		{
			name,
			hostname: machine.hostname,
			type: machine.type,
			online,
			status,
			services,
		},
		{ headers: CACHE_HEADERS },
	);
}

export async function handleStatusRoute(
	env: Env,
	path: string,
): Promise<Response | null> {
	if (path === "/api/status") {
		return fullStatus(env);
	}

	if (path === "/api/status/overall") {
		return overallStatus(env);
	}

	const serviceMatch = path.match(/^\/api\/status\/service\/(.+)$/);
	if (serviceMatch) {
		return serviceStatus(env, serviceMatch[1]);
	}

	const machineMatch = path.match(/^\/api\/status\/machine\/(.+)$/);
	if (machineMatch) {
		return machineStatus(env, machineMatch[1]);
	}

	return null;
}
