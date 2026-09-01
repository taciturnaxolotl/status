import type { Env, ServicesManifest, Snapshot } from "./types";
import { getManifest } from "./manifest";
import {
	getAllLatestPings,
	getAllUptime7d,
	getLastCheckTime,
	getOverallUptimeDays,
	getOverallUptimePct,
} from "./db/pings";
import { getActiveIncidents } from "./db/incidents";
import { getDeviceStatuses } from "./tailscale";

const KV_KEY = "read_snapshot";

// Three cron intervals. Past this the snapshot is stale enough that a request
// would rather pay for a rebuild than serve it.
const MAX_AGE_SECONDS = 15 * 60;

/**
 * Aggregate the rollups into the single object every read path serves from.
 * ~1.5k rows, run once per cron tick instead of millions of rows per request.
 */
export async function buildSnapshot(
	env: Env,
	manifest?: ServicesManifest,
): Promise<Snapshot> {
	const m = manifest ?? (await getManifest(env));
	const serverServiceIds = Object.values(m)
		.filter((machine) => machine.type === "server" && machine.services.some((s) => s.health_url))
		.flatMap((machine) => machine.services.filter((s) => s.health_url).map((s) => s.name));

	const [latest, uptime90, lastCheck, overallDays, overallPct, devices, incidents] =
		await Promise.all([
			getAllLatestPings(env.DB),
			getAllUptime7d(env.DB),
			getLastCheckTime(env.DB),
			getOverallUptimeDays(env.DB, 90, serverServiceIds),
			getOverallUptimePct(env.DB, 90, serverServiceIds),
			getDeviceStatuses(env),
			getActiveIncidents(env.DB),
		]);

	return {
		generated_at: Math.floor(Date.now() / 1000),
		last_check: lastCheck,
		latest: Object.fromEntries(latest),
		uptime90: Object.fromEntries(uptime90),
		overall_days: overallDays,
		overall_pct: overallPct,
		machine_online: Object.fromEntries(
			Object.entries(m).map(([name, machine]) => [
				name,
				devices.get(machine.tailscale_host.toLowerCase()) ?? false,
			]),
		),
		active_incidents: incidents,
	};
}

export async function writeSnapshot(env: Env, snapshot: Snapshot): Promise<void> {
	await env.KV.put(KV_KEY, JSON.stringify(snapshot));
}

/**
 * Read the snapshot the cron built. A missing or stale one is rebuilt inline,
 * so a cold KV or a failed cron degrades to the old cost instead of breaking.
 */
export async function getSnapshot(env: Env): Promise<Snapshot> {
	const cached = (await env.KV.get(KV_KEY, "json")) as Snapshot | null;
	const fresh =
		cached && Math.floor(Date.now() / 1000) - cached.generated_at < MAX_AGE_SECONDS;
	if (fresh) return cached;

	const snapshot = await buildSnapshot(env);
	await writeSnapshot(env, snapshot);
	return snapshot;
}
