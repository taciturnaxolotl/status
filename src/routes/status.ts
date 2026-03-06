import type { Env, StatusResponse } from "../types";
import { getManifest } from "../manifest";
import { getLatestPing, getUptime7d } from "../db";
import { getDeviceStatus } from "../tailscale";

export async function handleStatus(env: Env): Promise<Response> {
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
						name: svc.name,
						status: (ping?.status ?? "unknown") as
							| "up"
							| "degraded"
							| "down"
							| "unknown",
						latency_ms: ping?.latency_ms ?? null,
						uptime_7d: uptime,
					};
				}),
			);
			return {
				name,
				hostname: machine.hostname,
				type: machine.type,
				online,
				services,
			};
		}),
	);

	const ok = machines
		.filter((m) => m.type === "server")
		.every(
			(m) =>
				m.online &&
				m.services.every((s) => s.status === "up" || s.status === "unknown"),
		);

	return Response.json({ ok, machines } satisfies StatusResponse, {
		headers: { "Access-Control-Allow-Origin": "*" },
	});
}
