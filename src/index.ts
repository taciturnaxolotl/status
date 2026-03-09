import type { Env } from "./types";
import { getManifest } from "./manifest";
import { checkHealth } from "./health";
import { insertPing, getLatestPing, pruneOldPings, createIncident, updateIncident, addIncidentUpdate, getActiveIncidentForService, getActiveIncidents, getRecentlyResolvedIncident, getRecentlyResolvedIncidents, setIncidentGitHub } from "./db";
import { refreshDevices } from "./tailscale";
import { handleStatusRoute } from "./routes/status";
import { handleFavicon } from "./routes/favicon";
import { handleUptime } from "./routes/uptime";
import { handleBadgeRoute } from "./routes/badge";
import { handleIndex } from "./routes/index";
import { handleIncidentRoute } from "./routes/incidents";
import { createIssue, commentOnIssue, closeIssue, parseRepo, syncGitHubIncidents } from "./github";
import { schemas } from "./schemas";

async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === "/" || path === "") {
		return handleIndex(env);
	}

	if (path === "/favicon.svg") {
		return handleFavicon(env);
	}

	if (path === "/health") {
		return Response.json({ ok: true, timestamp: new Date().toISOString() });
	}

	if (path === "/api/schemas") {
		return Response.json(schemas);
	}

	const schemaMatch = path.match(/^\/api\/schemas\/(.+)$/);
	if (schemaMatch) {
		const schema = schemas[schemaMatch[1]];
		if (schema) {
			return Response.json(schema);
		}
		return Response.json({ error: "schema not found" }, { status: 404 });
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

	if (path.startsWith("/api/incidents")) {
		const res = await handleIncidentRoute(request, env, path);
		if (res) return res;
	}

	return new Response("Not Found", { status: 404 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
				},
			});
		}

		const response = await handleRequest(request, env);
		const corsResponse = new Response(response.body, response);
		corsResponse.headers.set("Access-Control-Allow-Origin", "*");
		return corsResponse;
	},

	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		const [manifest] = await Promise.all([
			getManifest(env),
			refreshDevices(env),
		]);

		const checks = Object.values(manifest).flatMap((machine) => {
			const triageUrl = machine.triage_url;
			return machine.services
				.filter((svc) => svc.health_url)
				.map(async (svc) => {
					const previous = await getLatestPing(env.DB, svc.name);
					const result = await checkHealth(svc);
					await insertPing(env.DB, svc.name, result.status, result.latency_ms);

					const isDown = result.status === "down" || result.status === "timeout";
					const wasUp = !previous || previous.status === "up" || previous.status === "degraded";

					if (isDown) {
						// Track consecutive failures in KV for flap prevention
						const failKey = `triage:${svc.name}:failures`;
						const current = parseInt((await env.KV.get(failKey)) ?? "0");
						const failures = current + 1;
						await env.KV.put(failKey, String(failures), { expirationTtl: 1800 });

						// Only trigger after 2 consecutive failures (10 min of downtime)
						if (failures >= 2) {
							const existing = await getActiveIncidentForService(env.DB, svc.name);
							if (!existing) {
								// Check cooldown: no incident resolved in last 15 min
								const recent = await getRecentlyResolvedIncident(env.DB, svc.name, 900);
								if (!recent) {
									const id = await createIncident(env.DB, {
										service_id: svc.name,
										title: `${svc.name} is ${result.status}`,
										severity: "major",
									});

									// Create GitHub issue on the service's repo
									if (env.GITHUB_TOKEN && svc.repository) {
										const parsed = parseRepo(svc.repository);
										if (parsed) {
											try {
												const issueNumber = await createIssue(env.GITHUB_TOKEN, parsed.owner, parsed.repo, {
													title: `${svc.name} is ${result.status}`,
													body: `Automated incident detected by [infra.dunkirk.sh](https://infra.dunkirk.sh)\n\n**Service:** ${svc.name}\n**Health URL:** ${svc.health_url}\n**Status:** ${result.status}${result.status_code ? ` (HTTP ${result.status_code})` : ""}${result.error ? ` — ${result.error}` : ""}\n**Latency:** ${result.latency_ms}ms\n**Detected at:** ${new Date().toISOString()}\n\n---\n*Comments on this issue will appear on the status page. Close the issue to resolve the incident.*`,
													assignees: env.GITHUB_ASSIGNEE ? [env.GITHUB_ASSIGNEE] : [],
													labels: ["incident"],
												});
												await setIncidentGitHub(env.DB, id, `${parsed.owner}/${parsed.repo}`, issueNumber);
											} catch (_) {} // best effort
										}
									}

									// Fire webhook to triage agent (non-blocking)
									if (triageUrl && env.TRIAGE_AUTH_TOKEN) {
										fetch(triageUrl, {
											method: "POST",
											headers: {
												"Content-Type": "application/json",
												Authorization: `Bearer ${env.TRIAGE_AUTH_TOKEN}`,
											},
											body: JSON.stringify({
												incident_id: id,
												service_id: svc.name,
												service_name: svc.name,
												health_url: svc.health_url,
												callback_url: `https://infra.dunkirk.sh/api/incidents/${id}`,
											}),
										}).catch(() => {}); // fire and forget
									}
								}
							}
						}
					} else {
						// Service is up — clear failure counter (only if one exists, to avoid unnecessary KV delete ops)
						const failKey = `triage:${svc.name}:failures`;
						if (await env.KV.get(failKey)) {
							await env.KV.delete(failKey);
						}

						// Auto-resolve active incidents
						const active = await getActiveIncidentForService(env.DB, svc.name);
						if (active) {
							await updateIncident(env.DB, active.id, {
								status: "resolved",
								resolved_at: Math.floor(Date.now() / 1000),
							});
							await addIncidentUpdate(env.DB, active.id, "resolved", "Service recovered automatically");

							// Close the GitHub issue
							if (env.GITHUB_TOKEN && active.github_repo && active.github_issue_number) {
								const parsed = parseRepo(`https://github.com/${active.github_repo}`);
								if (parsed) {
									commentOnIssue(env.GITHUB_TOKEN, parsed.owner, parsed.repo, active.github_issue_number, "Service recovered automatically. Closing issue.").catch(() => {});
									closeIssue(env.GITHUB_TOKEN, parsed.owner, parsed.repo, active.github_issue_number).catch(() => {});
								}
							}
						}
					}
				});
		});

		await Promise.all(checks);
		await pruneOldPings(env.DB, 365);

		// Sync GitHub issue comments/state back to incidents
		if (env.GITHUB_TOKEN) {
			const active = await getActiveIncidents(env.DB);
			const recentlyResolved = await getRecentlyResolvedIncidents(env.DB, 86400 * 7);
			const toSync = [...active, ...recentlyResolved];
			await syncGitHubIncidents(env.DB, env.KV, env.GITHUB_TOKEN, toSync);
		}
	},
} satisfies ExportedHandler<Env>;
