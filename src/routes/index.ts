import type { Env } from "../types";
import { getManifest } from "../manifest";
import { getLatestPing, getUptime7d } from "../db";
import { COMMIT_SHA } from "../version";

export async function handleIndex(env: Env): Promise<Response> {
	const manifest = await getManifest(env);

	const services = await Promise.all(
		manifest.map(async (svc) => {
			const ping = await getLatestPing(env.DB, svc.name);
			const uptime = await getUptime7d(env.DB, svc.name);
			return {
				name: svc.name,
				description: svc.description,
				url: `https://${svc.domain}`,
				status: ping?.status ?? "unknown",
				latency_ms: ping?.latency_ms ?? null,
				uptime_7d: uptime,
				has_health: svc.health_url !== null,
			};
		}),
	);

	const allUp = services.every(
		(s) => s.status === "up" || s.status === "unknown",
	);

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>infra.dunkirk.sh</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { min-height: 100%; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; max-width: 640px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }
  h1 { font-size: 1.1rem; font-weight: 500; margin-bottom: 0.25rem; }
  .overall { font-size: 0.85rem; color: #8b949e; margin-bottom: 2rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .dot.up { background: #2ecc71; }
  .dot.degraded { background: #f39c12; }
  .dot.down { background: #e74c3c; }
  .dot.unknown { background: #8b949e; }
  .service { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #21262d; }
  .service:last-child { border-bottom: none; }
  .svc-left { display: flex; align-items: center; gap: 0.25rem; }
  .svc-name { font-size: 0.85rem; }
  .svc-name a { color: #c9d1d9; text-decoration: none; }
  .svc-name a:hover { text-decoration: underline; }
  .svc-right { font-size: 0.75rem; color: #8b949e; display: flex; gap: 0; flex-shrink: 0; }
  .uptime { width: 3.5rem; text-align: right; }
  .latency { width: 3rem; text-align: right; }
  footer { margin-top: auto; padding-top: 1rem; border-top: 1px solid #21262d; font-size: 0.7rem; color: #8b949e; display: flex; justify-content: space-between; }
  footer a { color: #8b949e; text-decoration: none; }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>infra.dunkirk.sh</h1>
<p class="overall"><span class="dot ${allUp ? "up" : "degraded"}"></span>${allUp ? "All systems operational" : "Some systems degraded"}</p>
${services
	.map(
		(s) => `<div class="service">
  <div class="svc-left">
    <span class="dot ${s.status}"></span>
    <span class="svc-name"><a href="${esc(s.url)}">${esc(s.name)}</a></span>
  </div>
  <div class="svc-right">
    ${s.has_health ? `<span class="uptime">${s.uptime_7d}%</span><span class="latency">${s.latency_ms !== null ? s.latency_ms + "ms" : "—"}</span>` : `<span class="latency">no health check</span>`}
  </div>
</div>`,
	)
	.join("\n")}
<footer><span>checked every 5 min</span><a href="https://github.com/taciturnaxolotl/status/commit/${COMMIT_SHA}">${COMMIT_SHA}</a></footer>
</body>
</html>`;

	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=30",
		},
	});
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
