import type { Env } from "./types";
import { getManifest } from "./manifest";
import { getLatestPing, getActiveIncidents } from "./db";
import { getDeviceStatus } from "./tailscale";

export type OverallGrade = "up" | "degraded" | "down";

export interface OverallStatus {
	grade: OverallGrade;
	label: string;
}

export async function getOverallStatus(env: Env): Promise<OverallStatus> {
	const manifest = await getManifest(env);
	const servers = Object.entries(manifest).filter(
		([, m]) => m.type === "server" && m.services.length > 0,
	);

	const statuses: string[] = [];
	let anyServerOffline = false;

	for (const [, machine] of servers) {
		const online = await getDeviceStatus(env, machine.tailscale_host);
		if (!online) anyServerOffline = true;

		for (const svc of machine.services.filter((s) => s.health_url)) {
			const ping = await getLatestPing(env.DB, svc.name);
			statuses.push((ping?.status as string) ?? "unknown");
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

	const activeIncidents = await getActiveIncidents(env.DB);
	const hasCritical = activeIncidents.some((i) => i.severity === "critical");
	const hasMajor = activeIncidents.some((i) => i.severity === "major");

	if (hasCritical || onFire) return { grade: "down", label: "On fire" };
	if (hasMajor || hasDegraded) return { grade: "degraded", label: "Some systems degraded" };
	return { grade: "up", label: "All systems operational" };
}
