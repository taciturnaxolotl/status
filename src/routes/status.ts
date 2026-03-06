import type { Env, StatusResponse } from "../types";
import { getManifest } from "../manifest";
import { getLatestPing, getUptime7d } from "../db";

export async function handleStatus(env: Env): Promise<Response> {
	const manifest = await getManifest(env);

	const services = await Promise.all(
		manifest.map(async (svc) => {
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

	const ok = services.every((s) => s.status === "up" || s.status === "unknown");

	return Response.json({ ok, services } satisfies StatusResponse, {
		headers: { "Access-Control-Allow-Origin": "*" },
	});
}
