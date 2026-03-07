import type { Env } from "../types";
import { getManifest } from "../manifest";
import { getLatestPing, getUptime7d } from "../db";
import { getDeviceStatus } from "../tailscale";

const COLORS: Record<string, string> = {
	up: "#3cc068",
	degraded: "#f0ad4e",
	misconfigured: "#9b59b6",
	timeout: "#e05d44",
	partial: "#f0ad4e",
	down: "#e05d44",
	unknown: "#9f9f9f",
};

const STATUS_LABELS: Record<string, string> = {
	up: "operational",
	degraded: "degraded",
	misconfigured: "misconfigured",
	timeout: "timeout",
	partial: "partial",
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

function textColorForBg(hex: string): string {
	const c = hex.replace("#", "");
	const r = parseInt(c.slice(0, 2), 16);
	const g = parseInt(c.slice(2, 4), 16);
	const b = parseInt(c.slice(4, 6), 16);
	const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return lum > 0.5 ? "#333" : "#fff";
}

interface BadgeData {
	label: string;
	status: string;
	value: string;
}

interface StyleOpts {
	style: "flat" | "for-the-badge";
	colorA: string;
	colorB: string;
	label?: string;
}

function parseStyleOpts(url: URL, status: string): StyleOpts {
	const colorA = parseColor(url.searchParams.get("colorA")) ?? "#555";
	const colorB =
		parseColor(url.searchParams.get("colorB")) ??
		COLORS[status] ??
		COLORS.unknown;
	return {
		style:
			url.searchParams.get("style") === "for-the-badge"
				? "for-the-badge"
				: "flat",
		colorA,
		colorB,
		label: url.searchParams.get("label") ?? undefined,
	};
}

function parseColor(s: string | null): string | undefined {
	if (!s) return undefined;
	return s.startsWith("#") ? s : `#${s}`;
}

function renderBadge(data: BadgeData, opts: StyleOpts): string {
	const label = opts.label ?? data.label;
	return opts.style === "for-the-badge"
		? renderForTheBadge(label, data.value, opts.colorA, opts.colorB)
		: renderFlat(label, data.value, opts.colorA, opts.colorB);
}

function renderFlat(
	label: string,
	value: string,
	colorA: string,
	colorB: string,
): string {
	const pad = 20;
	const labelW = Math.round(textWidth(label) + pad);
	const valueW = Math.round(textWidth(value) + pad);
	const total = labelW + valueW;
	const labelX = labelW / 2;
	const valueX = labelW + valueW / 2;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img">
  <title>${esc(label)}: ${esc(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="${colorA}"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${colorB}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelX}" y="14" fill="${textColorForBg(colorA)}">${esc(label)}</text>
    <text x="${valueX}" y="14" fill="${textColorForBg(colorB)}">${esc(value)}</text>
  </g>
</svg>`;
}

function renderForTheBadge(
	label: string,
	value: string,
	colorA: string,
	colorB: string,
): string {
	const labelUp = label.toUpperCase();
	const valueUp = value.toUpperCase();
	const charW = 75;
	const pad = 240;
	const labelTL = labelUp.length * charW;
	const valueTL = valueUp.length * charW;
	const labelW = (labelTL + pad) / 10;
	const valueW = (valueTL + pad) / 10;
	const total = labelW + valueW;
	const labelX = labelW * 5;
	const valueX = (labelW + valueW / 2) * 10;
	const h = 28;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><g shape-rendering="crispEdges"><rect width="${labelW}" height="${h}" fill="${colorA}"/><rect x="${labelW}" width="${valueW}" height="${h}" fill="${colorB}"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100"><text transform="scale(.1)" x="${labelX}" y="175" textLength="${labelTL}" fill="${textColorForBg(colorA)}">${esc(labelUp)}</text><text transform="scale(.1)" x="${valueX}" y="175" textLength="${valueTL}" fill="${textColorForBg(colorB)}" font-weight="bold">${esc(valueUp)}</text></g></svg>`;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function worstStatus(statuses: string[]): string {
	if (statuses.length === 0) return "unknown";
	if (statuses.every((s) => s === "down" || s === "timeout")) return "down";
	if (statuses.includes("down") || statuses.includes("timeout")) return "partial";
	if (statuses.includes("misconfigured")) return "misconfigured";
	if (statuses.includes("degraded")) return "degraded";
	if (statuses.includes("unknown")) return "unknown";
	return "up";
}

const BADGE_HEADERS = {
	"Content-Type": "image/svg+xml",
	"Cache-Control": "no-cache, no-store, must-revalidate",
	"Access-Control-Allow-Origin": "*",
};

function badgeResponse(data: BadgeData, url: URL): Response {
	const opts = parseStyleOpts(url, data.status);
	return new Response(renderBadge(data, opts), { headers: BADGE_HEADERS });
}

// GET /badge/service/:id
async function serviceBadge(env: Env, id: string, url: URL): Promise<Response> {
	const ping = await getLatestPing(env.DB, id);
	const uptime = await getUptime7d(env.DB, id);
	const status = (ping?.status as string) ?? "unknown";
	const statusLabel = STATUS_LABELS[status] ?? "unknown";
	return badgeResponse(
		{ label: id, status, value: `${statusLabel} ${uptime}%` },
		url,
	);
}

// GET /badge/machine/:name
async function machineBadge(
	env: Env,
	name: string,
	url: URL,
): Promise<Response> {
	const manifest = await getManifest(env);
	const machine = manifest[name];
	if (!machine) {
		return new Response("Machine not found", { status: 404 });
	}

	const online = await getDeviceStatus(env, machine.tailscale_host);
	if (!online) {
		return badgeResponse({ label: name, status: "down", value: "offline" }, url);
	}

	const monitored = machine.services.filter((s) => s.health_url);
	if (monitored.length === 0) {
		return badgeResponse(
			{ label: name, status: online ? "up" : "down", value: online ? "online" : "offline" },
			url,
		);
	}

	const statuses: string[] = [];
	let totalUptime = 0;
	for (const svc of monitored) {
		const ping = await getLatestPing(env.DB, svc.name);
		const uptime = await getUptime7d(env.DB, svc.name);
		statuses.push((ping?.status as string) ?? "unknown");
		totalUptime += uptime;
	}

	const status = worstStatus(statuses);
	const avgUptime = Math.round((totalUptime / monitored.length) * 100) / 100;
	const statusLabel = STATUS_LABELS[status] ?? "unknown";
	return badgeResponse(
		{ label: name, status, value: `${statusLabel} ${avgUptime}%` },
		url,
	);
}

// GET /badge/overall
async function overallBadge(env: Env, url: URL): Promise<Response> {
	const manifest = await getManifest(env);
	const allServices = Object.values(manifest).flatMap((m) => m.services);
	const monitored = allServices.filter((s) => s.health_url !== null);

	const statuses: string[] = [];
	let totalUptime = 0;

	for (const svc of monitored) {
		const ping = await getLatestPing(env.DB, svc.name);
		const uptime = await getUptime7d(env.DB, svc.name);
		statuses.push((ping?.status as string) ?? "unknown");
		totalUptime += uptime;
	}

	const status = worstStatus(statuses);
	const avgUptime =
		monitored.length > 0
			? Math.round((totalUptime / monitored.length) * 100) / 100
			: 100;
	const statusLabel = STATUS_LABELS[status] ?? "unknown";
	return badgeResponse(
		{ label: "infra", status, value: `${statusLabel} ${avgUptime}%` },
		url,
	);
}

export async function handleBadgeRoute(
	env: Env,
	path: string,
	url: URL,
): Promise<Response | null> {
	if (path === "/badge" || path === "/badge/overall") {
		return overallBadge(env, url);
	}

	const serviceMatch = path.match(/^\/badge\/service\/(.+)$/);
	if (serviceMatch) {
		return serviceBadge(env, serviceMatch[1], url);
	}

	const machineMatch = path.match(/^\/badge\/machine\/(.+)$/);
	if (machineMatch) {
		return machineBadge(env, machineMatch[1], url);
	}

	// Legacy: /badge/:id → treat as service
	const legacyMatch = path.match(/^\/badge\/(.+)$/);
	if (legacyMatch) {
		return serviceBadge(env, legacyMatch[1], url);
	}

	return null;
}
