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

// The 90-day aggregates are the expensive third of a rebuild (~13k rows vs ~50)
// and they barely move: one check is 0.004% of a 90-day window. Recomputing them
// every tick cost 3.8M rows/day against a 5M/day limit, so they refresh hourly
// and every other field stays live on the 5-minute tick.
const HISTORY_MAX_AGE_SECONDS = 60 * 60;

/** The slice of the snapshot that summarises 90 days of history. */
type History = Pick<
	Snapshot,
	"history_generated_at" | "uptime90" | "overall_days" | "overall_pct"
>;

async function buildHistory(env: Env, manifest: ServicesManifest): Promise<History> {
	const serverServiceIds = Object.values(manifest)
		.filter((machine) => machine.type === "server" && machine.services.some((s) => s.health_url))
		.flatMap((machine) => machine.services.filter((s) => s.health_url).map((s) => s.name));

	const [uptime90, overallDays, overallPct] = await Promise.all([
		getAllUptime7d(env.DB),
		getOverallUptimeDays(env.DB, 90, serverServiceIds),
		getOverallUptimePct(env.DB, 90, serverServiceIds),
	]);

	return {
		history_generated_at: Math.floor(Date.now() / 1000),
		uptime90: Object.fromEntries(uptime90),
		overall_days: overallDays,
		overall_pct: overallPct,
	};
}

async function readSnapshot(env: Env): Promise<Snapshot | null> {
	return ((await env.KV.get(KV_KEY, "json")) as Snapshot | null) ?? null;
}

/**
 * Aggregate the rollups into the single object every read path serves from.
 * `previous` carries the last snapshot so the 90-day history can be reused
 * until it ages out; pass null to force a full rebuild.
 */
export async function buildSnapshot(
	env: Env,
	manifest?: ServicesManifest,
	previous?: Snapshot | null,
): Promise<Snapshot> {
	const m = manifest ?? (await getManifest(env));
	const now = Math.floor(Date.now() / 1000);
	const reusable =
		previous?.history_generated_at &&
		now - previous.history_generated_at < HISTORY_MAX_AGE_SECONDS
			? previous
			: null;

	const [latest, lastCheck, devices, incidents, history] = await Promise.all([
		getAllLatestPings(env.DB),
		getLastCheckTime(env.DB),
		getDeviceStatuses(env),
		getActiveIncidents(env.DB),
		reusable
			? Promise.resolve<History>({
					history_generated_at: reusable.history_generated_at,
					uptime90: reusable.uptime90,
					overall_days: reusable.overall_days,
					overall_pct: reusable.overall_pct,
				})
			: buildHistory(env, m),
	]);

	return {
		generated_at: now,
		last_check: lastCheck,
		latest: Object.fromEntries(latest),
		machine_online: Object.fromEntries(
			Object.entries(m).map(([name, machine]) => [
				name,
				devices.get(machine.tailscale_host.toLowerCase()) ?? false,
			]),
		),
		active_incidents: incidents,
		...history,
	};
}

export async function writeSnapshot(env: Env, snapshot: Snapshot): Promise<void> {
	await env.KV.put(KV_KEY, JSON.stringify(snapshot));
}

/** Rebuild and store the snapshot, reusing history that is still fresh. */
export async function refreshSnapshot(
	env: Env,
	manifest: ServicesManifest,
): Promise<void> {
	await writeSnapshot(env, await buildSnapshot(env, manifest, await readSnapshot(env)));
}

/**
 * Read the snapshot the cron built. A missing or stale one is rebuilt inline,
 * so a cold KV or a failed cron degrades to the old cost instead of breaking.
 */
export async function getSnapshot(env: Env): Promise<Snapshot> {
	const cached = await readSnapshot(env);
	if (cached && Math.floor(Date.now() / 1000) - cached.generated_at < MAX_AGE_SECONDS) {
		return cached;
	}

	const snapshot = await buildSnapshot(env, undefined, cached);
	await writeSnapshot(env, snapshot);
	return snapshot;
}
