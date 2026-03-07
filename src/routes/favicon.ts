import type { Env } from "../types";
import { getOverallStatus, type OverallGrade } from "../overall";

const COLORS: Record<OverallGrade, string> = {
	up: "#2ecc71",
	degraded: "#f39c12",
	down: "#e74c3c",
};

export async function handleFavicon(env: Env): Promise<Response> {
	const { grade } = await getOverallStatus(env);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${COLORS[grade]}"/></svg>`;

	return new Response(svg, {
		headers: {
			"Content-Type": "image/svg+xml",
			"Cache-Control": "no-cache, no-store, must-revalidate",
		},
	});
}
