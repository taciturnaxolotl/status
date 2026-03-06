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
const WIDTHS_11: Record<string, number> = {
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

function textWidth(s: string, scale: number = 1): number {
	let w = 0;
	for (const c of s) w += (WIDTHS_11[c] ?? 6.5) * scale;
	return w;
}

type BadgeStyle = "flat" | "for-the-badge";

interface BadgeOptions {
	label: string;
	status: string;
	uptime: number;
	style?: BadgeStyle;
	colorA?: string;
	colorB?: string;
}

function makeBadge(opts: BadgeOptions): string {
	const style = opts.style ?? "flat";
	return style === "for-the-badge" ? makeForTheBadge(opts) : makeFlat(opts);
}

function makeFlat(opts: BadgeOptions): string {
	const color = opts.colorB ?? COLORS[opts.status] ?? COLORS.unknown;
	const labelColor = opts.colorA ?? "#555";
	const statusLabel = STATUS_LABELS[opts.status] ?? "unknown";
	const value = `${statusLabel} ${opts.uptime}%`;

	const pad = 20;
	const labelW = Math.round(textWidth(opts.label) + pad);
	const valueW = Math.round(textWidth(value) + pad);
	const total = labelW + valueW;
	const labelX = labelW / 2;
	const valueX = labelW + valueW / 2;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img">
  <title>${esc(opts.label)}: ${esc(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="${labelColor}"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelX}" y="14" fill="${textColorForBg(labelColor)}">${esc(opts.label)}</text>
    <text x="${valueX}" y="14" fill="${textColorForBg(color)}">${esc(value)}</text>
  </g>
</svg>`;
}

function makeForTheBadge(opts: BadgeOptions): string {
	const color = opts.colorB ?? COLORS[opts.status] ?? COLORS.unknown;
	const labelColor = opts.colorA ?? "#555";
	const statusLabel = STATUS_LABELS[opts.status] ?? "unknown";
	const value = `${statusLabel} ${opts.uptime}%`.toUpperCase();
	const label = opts.label.toUpperCase();

	// shields.io uses 10x scale trick: font-size 100 + scale(.1)
	// textLength controls letter spacing, ~75 per char for label, ~75 per char for value
	const charW = 75;
	const pad = 240; // padding in 10x space (24px real)
	const labelTL = label.length * charW;
	const valueTL = value.length * charW;
	const labelW = (labelTL + pad) / 10;
	const valueW = (valueTL + pad) / 10;
	const total = labelW + valueW;
	const labelX = labelW * 5; // center in 10x space
	const valueX = (labelW + valueW / 2) * 10;
	const h = 28;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${esc(opts.label)}: ${esc(value)}"><title>${esc(opts.label)}: ${esc(value)}</title><g shape-rendering="crispEdges"><rect width="${labelW}" height="${h}" fill="${labelColor}"/><rect x="${labelW}" width="${valueW}" height="${h}" fill="${color}"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="100"><text transform="scale(.1)" x="${labelX}" y="175" textLength="${labelTL}" fill="${textColorForBg(labelColor)}">${esc(label)}</text><text transform="scale(.1)" x="${valueX}" y="175" textLength="${valueTL}" fill="${textColorForBg(color)}" font-weight="bold">${esc(value)}</text></g></svg>`;
}

function textColorForBg(hex: string): string {
	const c = hex.replace("#", "");
	const r = parseInt(c.slice(0, 2), 16);
	const g = parseInt(c.slice(2, 4), 16);
	const b = parseInt(c.slice(4, 6), 16);
	// W3C relative luminance
	const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return lum > 0.5 ? "#333" : "#fff";
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseColor(s: string | null): string | undefined {
	if (!s) return undefined;
	return s.startsWith("#") ? s : `#${s}`;
}

function parseOpts(url: URL): Partial<BadgeOptions> {
	return {
		style: (url.searchParams.get("style") as BadgeStyle) ?? undefined,
		colorA: parseColor(url.searchParams.get("colorA")),
		colorB: parseColor(url.searchParams.get("colorB")),
	};
}

const BADGE_HEADERS = {
	"Content-Type": "image/svg+xml",
	"Cache-Control": "no-cache, no-store, must-revalidate",
	"Access-Control-Allow-Origin": "*",
};

export async function handleBadge(
	env: Env,
	serviceId: string,
	url: URL,
): Promise<Response> {
	const ping = await getLatestPing(env.DB, serviceId);
	const uptime = await getUptime7d(env.DB, serviceId);
	const status = (ping?.status as string) ?? "unknown";
	const opts = parseOpts(url);

	return new Response(
		makeBadge({ label: serviceId, status, uptime, ...opts }),
		{ headers: BADGE_HEADERS },
	);
}

export async function handleOverallBadge(env: Env, url: URL): Promise<Response> {
	const manifest = await getManifest(env);
	const allServices = Object.values(manifest).flatMap((m) => m.services);
	const monitored = allServices.filter((s) => s.health_url !== null);

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
	const opts = parseOpts(url);

	return new Response(
		makeBadge({ label: "infra", status: worst, uptime: avgUptime, ...opts }),
		{ headers: BADGE_HEADERS },
	);
}
