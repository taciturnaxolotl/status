import type { Env } from "../types";
import { getManifest } from "../manifest";
import { getLatestPing, getUptime7d } from "../db";

const COLORS: Record<string, string> = {
	up: "#3cc068",
	degraded: "#f0ad4e",
	down: "#e05d44",
	unknown: "#9f9f9f",
};

const STATUS_LABELS: Record<string, string> = {
	up: "operational",
	degraded: "degraded",
	down: "down",
	unknown: "unknown",
};

// Verdana character width table at 11px (from shields.io)
const WIDTHS: Record<string, number> = {
	" ": 3.3, "!": 4.2, '"': 5.2, "#": 7.8, $: 6.3, "%": 9.5, "&": 7.6,
	"'": 2.8, "(": 4.2, ")": 4.2, "*": 6.3, "+": 7.8, ",": 3.5, "-": 4.4,
	".": 3.5, "/": 4.8, "0": 6.3, "1": 6.3, "2": 6.3, "3": 6.3, "4": 6.3,
	"5": 6.3, "6": 6.3, "7": 6.3, "8": 6.3, "9": 6.3, ":": 4.2, ";": 4.2,
	"<": 7.8, "=": 7.8, ">": 7.8, "?": 5.6, "@": 10.3, A: 7.3, B: 7.0,
	C: 6.7, D: 7.6, E: 6.2, F: 5.7, G: 7.6, H: 7.6, I: 4.2, J: 4.2,
	K: 7.0, L: 6.0, M: 8.9, N: 7.6, O: 7.6, P: 6.2, Q: 7.6, R: 7.0,
	S: 6.7, T: 6.2, U: 7.6, V: 7.0, W: 9.5, X: 6.5, Y: 6.2, Z: 6.7,
	a: 5.8, b: 6.5, c: 5.0, d: 6.5, e: 5.8, f: 3.9, g: 6.5, h: 6.5,
	i: 3.0, j: 3.6, k: 6.1, l: 3.0, m: 9.5, n: 6.5, o: 6.2, p: 6.5,
	q: 6.5, r: 4.6, s: 5.2, t: 4.2, u: 6.5, v: 5.8, w: 8.4, x: 5.6,
	y: 5.8, z: 5.0, "|": 4.2,
};

function textWidth(s: string): number {
	let w = 0;
	for (const c of s) w += WIDTHS[c] ?? 6.5;
	return w;
}

function makeBadge(label: string, status: string, uptime: number): string {
	const color = COLORS[status] ?? COLORS.unknown;
	const statusLabel = STATUS_LABELS[status] ?? "unknown";
	const value = `${statusLabel} ${uptime}%`;

	const pad = 20;
	const labelW = Math.round(textWidth(label) + pad);
	const valueW = Math.round(textWidth(value) + pad);
	const total = labelW + valueW;
	const labelX = labelW / 2;
	const valueX = labelW + valueW / 2;

	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${total}" height="20" role="img">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text aria-hidden="true" x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text>
    <text x="${labelX}" y="14">${esc(label)}</text>
    <text aria-hidden="true" x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text>
    <text x="${valueX}" y="14">${esc(value)}</text>
  </g>
</svg>`;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BADGE_HEADERS = {
	"Content-Type": "image/svg+xml",
	"Cache-Control": "no-cache, no-store, must-revalidate",
	"Access-Control-Allow-Origin": "*",
};

export async function handleBadge(
	env: Env,
	serviceId: string,
): Promise<Response> {
	const ping = await getLatestPing(env.DB, serviceId);
	const uptime = await getUptime7d(env.DB, serviceId);
	const status = (ping?.status as string) ?? "unknown";

	return new Response(makeBadge(serviceId, status, uptime), {
		headers: BADGE_HEADERS,
	});
}

export async function handleOverallBadge(env: Env): Promise<Response> {
	const manifest = await getManifest(env);
	const monitored = manifest.filter((s) => s.health_url !== null);

	let worst: string = "up";
	let totalUptime = 0;

	for (const svc of monitored) {
		const ping = await getLatestPing(env.DB, svc.name);
		const uptime = await getUptime7d(env.DB, svc.name);
		totalUptime += uptime;
		const s = (ping?.status as string) ?? "unknown";
		if (s === "down") worst = "down";
		else if (s === "degraded" && worst !== "down") worst = "degraded";
		else if (s === "unknown" && worst === "up") worst = "unknown";
	}

	const avgUptime =
		monitored.length > 0
			? Math.round((totalUptime / monitored.length) * 100) / 100
			: 100;

	return new Response(makeBadge("infra", worst, avgUptime), {
		headers: BADGE_HEADERS,
	});
}
