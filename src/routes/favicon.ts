import type { Env } from "../types";
import { getManifest } from "../manifest";
import { getOverallStatus, type OverallGrade } from "../overall";
import { getSnapshot } from "../snapshot";

const COLORS: Record<OverallGrade, string> = {
	up: "#2ecc71",
	degraded: "#f39c12",
	down: "#e74c3c",
};

export async function handleFavicon(env: Env): Promise<Response> {
	const [manifest, snapshot] = await Promise.all([getManifest(env), getSnapshot(env)]);
	const { grade } = getOverallStatus(manifest, snapshot, snapshot.active_incidents);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${COLORS[grade]}"/></svg>`;

	return new Response(svg, {
		headers: {
			"Content-Type": "image/svg+xml",
			// Was no-cache/no-store, so every page load re-ran the whole
			// overall-status computation. The data only changes once per cron tick.
			"Cache-Control": "public, max-age=300",
		},
	});
}
