import type { Env } from "../types";
import { getManifest } from "../manifest";
import { getLatestPing } from "../db";

const COLORS: Record<string, string> = {
	up: "#2ecc71",
	degraded: "#f39c12",
	down: "#e74c3c",
};

export async function handleFavicon(env: Env): Promise<Response> {
	const manifest = await getManifest(env);
	const activeServers = Object.values(manifest).filter(
		(m) => m.type === "server" && m.services.length > 0,
	);
	const statuses: string[] = [];

	for (const machine of activeServers) {
		for (const svc of machine.services.filter((s) => s.health_url)) {
			const ping = await getLatestPing(env.DB, svc.name);
			statuses.push((ping?.status as string) ?? "unknown");
		}
	}

	const downCount = statuses.filter((s) => s === "down" || s === "timeout").length;
	const downRatio = statuses.length > 0 ? downCount / statuses.length : 0;
	const hasIssues = statuses.some(
		(s) => s === "down" || s === "timeout" || s === "degraded" || s === "misconfigured",
	);

	let color: string;
	if (downRatio >= 0.4) color = COLORS.down;
	else if (hasIssues) color = COLORS.degraded;
	else color = COLORS.up;

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${color}"/></svg>`;

	return new Response(svg, {
		headers: {
			"Content-Type": "image/svg+xml",
			"Cache-Control": "no-cache, no-store, must-revalidate",
		},
	});
}
