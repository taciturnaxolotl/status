import type { Env, Incident, ServicesManifest } from "./types";
import { getManifest } from "./manifest";
import { getAllLatestPings, getActiveIncidents } from "./db";
import { getDeviceStatus } from "./tailscale";

export type OverallGrade = "up" | "degraded" | "down";

export interface OverallStatus {
	grade: OverallGrade;
	label: string;
}

export async function getOverallStatus(
	env: Env,
	prefetched?: {
		manifest?: ServicesManifest;
		latestPings?: Map<string, { status: string; latency_ms: number | null }>;
		activeIncidents?: Incident[];
		machineOnline?: Map<string, boolean>;
	},
): Promise<OverallStatus> {
	const manifest = prefetched?.manifest ?? await getManifest(env);
	const latestPings = prefetched?.latestPings ?? await getAllLatestPings(env.DB);
	const activeIncidents = prefetched?.activeIncidents ?? await getActiveIncidents(env.DB);

	const servers = Object.entries(manifest).filter(
		([, m]) => m.type === "server" && m.services.length > 0,
	);

	const statuses: string[] = [];
	let anyServerOffline = false;

	for (const [name, machine] of servers) {
		const online = prefetched?.machineOnline?.get(name) ?? await getDeviceStatus(env, machine.tailscale_host);
		if (!online) anyServerOffline = true;

		for (const svc of machine.services.filter((s) => s.health_url)) {
			const ping = latestPings.get(svc.name);
			statuses.push(ping?.status ?? "unknown");
		}
	}

	const downCount = statuses.filter(
		(s) => s === "down" || s === "timeout",
	).length;
	const downRatio = statuses.length > 0 ? downCount / statuses.length : 0;
	const onFire = anyServerOffline || downRatio >= 0.4;
	const hasDegraded = statuses.some(
		(s) =>
			s === "down" ||
			s === "timeout" ||
			s === "degraded" ||
			s === "misconfigured",
	);

	const hasCritical = activeIncidents.some((i) => i.severity === "critical");
	const hasMajor = activeIncidents.some((i) => i.severity === "major");

	if (hasCritical || onFire) return { grade: "down", label: "On fire" };
	if (hasMajor || hasDegraded) return { grade: "degraded", label: "Some systems degraded" };
	return { grade: "up", label: "All systems operational" };
}
