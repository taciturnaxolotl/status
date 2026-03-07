import type { Env, ServicesManifest } from "./types";

const MANIFEST_URL = "https://dots.dunkirk.sh/services.json";
const KV_KEY = "services_manifest";
const TTL_SECONDS = 300;

export async function getManifest(env: Env): Promise<ServicesManifest> {
	const cached = await env.KV.get(KV_KEY, "json");
	if (cached) return cached as ServicesManifest;

	const res = await fetch(MANIFEST_URL);
	if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);

	const manifest: ServicesManifest = await res.json();
	await env.KV.put(KV_KEY, JSON.stringify(manifest), {
		expirationTtl: TTL_SECONDS,
	});

	return manifest;
}
