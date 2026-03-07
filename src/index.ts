import type { Env } from "./types";
import { getManifest } from "./manifest";
import { checkHealth } from "./health";
import { insertPing, pruneOldPings } from "./db";
import { refreshDevices } from "./tailscale";
import { handleStatusRoute } from "./routes/status";
import { handleUptime } from "./routes/uptime";
import { handleBadgeRoute } from "./routes/badge";
import { handleIndex } from "./routes/index";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === "/" || path === "") {
			return handleIndex(env);
		}

		if (path.startsWith("/api/status")) {
			const res = await handleStatusRoute(env, path);
			if (res) return res;
		}

		const uptimeMatch = path.match(/^\/api\/uptime\/(.+)$/);
		if (uptimeMatch) {
			return handleUptime(env, uptimeMatch[1], url);
		}

		if (path.startsWith("/badge")) {
			const badge = await handleBadgeRoute(env, path, url);
			if (badge) return badge;
		}

		return new Response("Not Found", { status: 404 });
	},

	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		const [manifest] = await Promise.all([
			getManifest(env),
			refreshDevices(env),
		]);

		const checks = Object.values(manifest).flatMap((machine) =>
			machine.services
				.filter((svc) => svc.health_url)
				.map(async (svc) => {
					const result = await checkHealth(svc);
					await insertPing(env.DB, svc.name, result.status, result.latency_ms);
				}),
		);

		await Promise.all(checks);
		await pruneOldPings(env.DB, 90);
	},
} satisfies ExportedHandler<Env>;
