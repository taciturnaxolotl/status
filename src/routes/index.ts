import type { Env } from "../types";
import { getManifest } from "../manifest";
import { getLatestPing, getUptime7d, getOverallUptimeDays, getLastCheckTime } from "../db";
import { getDeviceStatus } from "../tailscale";
import { getOverallStatus } from "../overall";
import { COMMIT_SHA } from "../version";

export async function handleIndex(env: Env): Promise<Response> {
	const manifest = await getManifest(env);

	const machines = await Promise.all(
		Object.entries(manifest).map(async ([name, machine]) => {
			const online = await getDeviceStatus(env, machine.tailscale_host);
			const services = await Promise.all(
				machine.services.map(async (svc) => {
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
			return { name, type: machine.type, online, services };
		}),
	);

	const lastCheck = await getLastCheckTime(env.DB);
	const lastCheckISO = lastCheck
		? new Date(lastCheck * 1000).toISOString()
		: null;

	const servers = machines.filter((m) => m.type === "server");
	const clients = machines.filter((m) => m.type === "client");

	const { grade: overallClass, label: overallText } = await getOverallStatus(env);
	const uptimeDays = await getOverallUptimeDays(env.DB, 90);

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>infra.dunkirk.sh</title>
<meta name="description" content="${overallText}">
<meta property="og:title" content="infra.dunkirk.sh">
<meta property="og:description" content="${overallText}">
<meta property="og:image" content="https://l4.dunkirk.sh/i/fxRXrFoB2OgE.png">
<meta property="og:url" content="https://infra.dunkirk.sh">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="infra.dunkirk.sh">
<meta name="twitter:description" content="${overallText}">
<meta name="twitter:image" content="https://l4.dunkirk.sh/i/fxRXrFoB2OgE.png">
<meta name="theme-color" content="${overallClass === "up" ? "#2ecc71" : overallClass === "degraded" ? "#f39c12" : "#e74c3c"}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
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
  .dot.misconfigured { background: #9b59b6; }
  .dot.timeout { background: #e74c3c; }
  .dot.unknown { background: #8b949e; }
  .dot.online { background: #2ecc71; }
  .dot.offline { background: #e74c3c; }
  .machine { margin-bottom: 1.5rem; }
  .machine-header { display: flex; align-items: center; gap: 0.25rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b949e; margin-bottom: 0.5rem; }
  .machine-type { font-size: 0.6rem; background: #21262d; padding: 0.1rem 0.4rem; border-radius: 3px; margin-left: 0.4rem; }
  .service { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #21262d; }
  .service:last-child { border-bottom: none; }
  .svc-left { display: flex; align-items: center; gap: 0.25rem; }
  .svc-name { font-size: 0.85rem; }
  .svc-name a { color: #c9d1d9; text-decoration: none; }
  .svc-name a:hover { text-decoration: underline; }
  .svc-right { font-size: 0.75rem; color: #8b949e; display: flex; gap: 0; flex-shrink: 0; }
  .uptime { width: 3.5rem; text-align: right; }
  .latency { width: 3rem; text-align: right; }
  .no-services { font-size: 0.8rem; color: #8b949e; padding: 0.25rem 0; }
  .clients { margin-bottom: 1.5rem; }
  .clients-header { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b949e; margin-bottom: 0.5rem; }
  .clients-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .client { display: flex; align-items: center; gap: 0.25rem; font-size: 0.8rem; color: #8b949e; }
  .uptime-bar { display: flex; position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 10; }
  .uptime-bar .day { flex: 1; }
  .uptime-bar .day.up { background: #2ecc71; }
  .uptime-bar .day.degraded { background: #f39c12; }
  .uptime-bar .day.down { background: #e74c3c; }
  .uptime-bar .day.none { background: #21262d; }
  footer { margin-top: auto; padding-top: 1rem; border-top: 1px solid #21262d; font-size: 0.7rem; color: #8b949e; }
  .footer-meta { display: flex; justify-content: space-between; }
  footer a { color: #8b949e; text-decoration: none; }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="uptime-bar">${uptimeDays.map((d) => `<div class="day ${d.status}" title="${d.date}: ${d.status}"></div>`).join("")}</div>
<h1>infra.dunkirk.sh</h1>
<p class="overall"><span class="dot ${overallClass}" id="overall-dot" title="${overallClass}"></span><span id="overall-text">${overallText}</span></p>
${servers
	.map(
		(m) => `<div class="machine">
<div class="machine-header"><span class="dot ${m.online ? "online" : m.services.length === 0 ? "unknown" : "offline"}" data-machine="${esc(m.name)}" title="${m.online ? "online" : "offline"}"></span>${esc(m.name)}<span class="machine-type">${esc(m.type)}</span></div>
${m.services.length === 0 ? `<div class="no-services">no services</div>` : m.services
	.map(
		(s) => `<div class="service">
  <div class="svc-left">
    <span class="dot ${s.status}" data-service="${esc(s.name)}" title="${s.status}"></span>
    <span class="svc-name"><a href="${esc(s.url)}">${esc(s.name)}</a></span>
  </div>
  <div class="svc-right">
    ${s.has_health ? `<span class="uptime" data-service-uptime="${esc(s.name)}">${s.uptime_7d}%</span><span class="latency" data-service-latency="${esc(s.name)}">${s.latency_ms !== null ? s.latency_ms + "ms" : "—"}</span>` : `<span class="latency">no health check</span>`}
  </div>
</div>`,
	)
	.join("\n")}
</div>`,
	)
	.join("\n")}
${clients.length > 0 ? `<div class="clients">
<div class="clients-header">devices</div>
<div class="clients-list">
${clients.map((m) => `<span class="client"><span class="dot ${m.online ? "online" : "unknown"}" data-machine="${esc(m.name)}" title="${m.online ? "online" : "offline"}"></span>${esc(m.name)}</span>`).join("\n")}
</div>
</div>` : ""}
<footer>
<div class="footer-meta"><span>${lastCheckISO ? `updated <relative-time datetime="${lastCheckISO}" prefix="">loading</relative-time>` : "no checks yet"}</span><a href="https://github.com/taciturnaxolotl/status/commit/${COMMIT_SHA}">${COMMIT_SHA}</a></div>
</footer>
<script>
class RelativeTimeElement extends HTMLElement {
  static get observedAttributes() { return ['datetime']; }
  connectedCallback() { this.update(); }
  disconnectedCallback() { this.timer && clearTimeout(this.timer); }
  attributeChangedCallback() { this.update(); }
  get datetime() { return this.getAttribute('datetime') || ''; }
  update() {
    const d = this.datetime;
    if (!d) return;
    const date = new Date(d);
    if (isNaN(date.getTime())) return;
    const diff = Date.now() - date.getTime();
    const abs = Math.abs(diff);
    const s = Math.floor(abs / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const days = Math.floor(h / 24);
    const rtf = new Intl.RelativeTimeFormat(navigator.language, { numeric: 'auto' });
    const sign = diff > 0 ? -1 : 1;
    if (s < 60) this.textContent = rtf.format(sign * s, 'second');
    else if (m < 60) this.textContent = rtf.format(sign * m, 'minute');
    else if (h < 24) this.textContent = rtf.format(sign * h, 'hour');
    else this.textContent = rtf.format(sign * days, 'day');
    const delay = s < 60 ? 1000 : m < 60 ? 60000 : 3600000;
    this.timer = setTimeout(() => this.update(), delay);
  }
}
customElements.define('relative-time', RelativeTimeElement);

const CHECK_INTERVAL = 5 * 60 * 1000;
const BUFFER = 10 * 1000;
const OVERALL_LABELS = { up: 'All systems operational', degraded: 'Some systems degraded', down: 'On fire' };

function updateFavicon(status) {
  const colors = { up: '#2ecc71', degraded: '#f39c12', down: '#e74c3c' };
  const color = colors[status] || '#8b949e';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="' + color + '"/></svg>';
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function setDot(el, cls) {
  el.className = 'dot ' + cls;
  el.title = cls;
}

function applyUpdate(data) {
  updateFavicon(data.status);
  const dot = document.getElementById('overall-dot');
  const text = document.getElementById('overall-text');
  if (dot) setDot(dot, data.status);
  if (text) text.textContent = OVERALL_LABELS[data.status] || data.status;

  for (const machine of data.machines) {
    const mDot = document.querySelector('[data-machine="' + machine.name + '"]');
    if (mDot) setDot(mDot, machine.online ? 'online' : machine.services.length === 0 ? 'unknown' : 'offline');
    for (const svc of machine.services) {
      const sDot = document.querySelector('[data-service="' + svc.id + '"]');
      if (sDot) setDot(sDot, svc.status);
      const uEl = document.querySelector('[data-service-uptime="' + svc.id + '"]');
      if (uEl) uEl.textContent = svc.uptime_7d + '%';
      const lEl = document.querySelector('[data-service-latency="' + svc.id + '"]');
      if (lEl) lEl.textContent = svc.latency_ms !== null ? svc.latency_ms + 'ms' : '—';
    }
  }

  if (data.last_check) {
    const rt = document.querySelector('relative-time');
    if (rt) rt.setAttribute('datetime', new Date(data.last_check * 1000).toISOString());
  }
}

function scheduleRefresh() {
  fetch('/api/status').then(r => r.json()).then(data => {
    applyUpdate(data);
    if (!data.last_check) { setTimeout(scheduleRefresh, CHECK_INTERVAL); return; }
    const lastCheck = data.last_check * 1000;
    const nextCheck = lastCheck + CHECK_INTERVAL + BUFFER;
    const delay = Math.max(nextCheck - Date.now(), BUFFER);
    setTimeout(scheduleRefresh, delay);
  }).catch(() => { setTimeout(scheduleRefresh, CHECK_INTERVAL); });
}
scheduleRefresh();
</script>
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
