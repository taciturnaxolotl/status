import type { Incident, ServicesManifest, Snapshot } from "./types";

export type OverallGrade = "up" | "degraded" | "down";

export interface OverallStatus {
	grade: OverallGrade;
	label: string;
}

/**
 * Pure: everything it needs is already in the snapshot the cron built. Callers
 * pass the incident list explicitly so the page, which loads incidents anyway,
 * can grade against the live set while cached routes grade against the snapshot.
 */
export function getOverallStatus(
	manifest: ServicesManifest,
	snapshot: Snapshot,
	activeIncidents: Incident[],
): OverallStatus {
	const servers = Object.entries(manifest).filter(
		([, m]) => m.type === "server" && m.services.some((s) => s.health_url),
	);

	const statuses: string[] = [];
	let anyServerOffline = false;

	for (const [name, machine] of servers) {
		if (!snapshot.machine_online[name]) anyServerOffline = true;

		for (const svc of machine.services.filter((s) => s.health_url)) {
			statuses.push(snapshot.latest[svc.name]?.status ?? "unknown");
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
