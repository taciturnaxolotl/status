import type { Env } from "../types";
import { getManifest } from "../manifest";
import { getLatestPing, getUptime7d } from "../db";
import { getDeviceStatus } from "../tailscale";
import { getOverallStatus } from "../overall";

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
	const manifest = await getManifest(env);
	const allServices = Object.values(manifest).flatMap((m) => m.services);
	const monitored = allServices.filter((s) => s.health_url !== null);

	let totalUptime = 0;
	for (const svc of monitored) {
		const uptime = await getUptime7d(env.DB, svc.name);
		totalUptime += uptime;
	}

	const { grade } = await getOverallStatus(env);
	const avgUptime =
		monitored.length > 0
			? Math.round((totalUptime / monitored.length) * 100) / 100
			: 100;

	return Response.json(
		{
			ok: grade === "up",
			status: grade,
			uptime_7d: avgUptime,
			services_total: allServices.length,
			services_monitored: monitored.length,
			machines_total: Object.keys(manifest).length,
		}	);
}

// GET /api/status
async function fullStatus(env: Env): Promise<Response> {
	const manifest = await getManifest(env);

	const machines = await Promise.all(
		Object.entries(manifest).map(async ([name, machine]) => {
			const online = await getDeviceStatus(env, machine.tailscale_host);
			const services = await Promise.all(
				machine.services.map(async (svc) => {
					const ping = await getLatestPing(env.DB, svc.name);
					const uptime = await getUptime7d(env.DB, svc.name);
					return {
						id: svc.name,
						status: (ping?.status ?? "unknown") as string,
						latency_ms: ping?.latency_ms ?? null,
						uptime_7d: uptime,
					};
				}),
			);
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
		}),
	);

	const { grade } = await getOverallStatus(env);

	return Response.json(
		{
			ok: grade === "up",
			status: grade,
			machines,
		}	);
}

// GET /api/status/service/:id
async function serviceStatus(env: Env, id: string): Promise<Response> {
	const ping = await getLatestPing(env.DB, id);
	const uptime = await getUptime7d(env.DB, id);

	if (!ping) {
		return Response.json({ error: "service not found" }, { status: 404 });
	}

	return Response.json(
		{
			id,
			status: ping.status,
			latency_ms: ping.latency_ms,
			uptime_7d: uptime,
		}	);
}

// GET /api/status/machine/:name
async function machineStatus(env: Env, name: string): Promise<Response> {
	const manifest = await getManifest(env);
	const machine = manifest[name];

	if (!machine) {
		return Response.json({ error: "machine not found" }, { status: 404 });
	}

	const online = await getDeviceStatus(env, machine.tailscale_host);
	const services = await Promise.all(
		machine.services.map(async (svc) => {
			const ping = await getLatestPing(env.DB, svc.name);
			const uptime = await getUptime7d(env.DB, svc.name);
			return {
				id: svc.name,
				status: (ping?.status ?? "unknown") as string,
				latency_ms: ping?.latency_ms ?? null,
				uptime_7d: uptime,
			};
		}),
	);

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
		}	);
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
