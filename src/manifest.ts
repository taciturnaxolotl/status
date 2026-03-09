import type { Env, ServicesManifest } from "./types";

const MANIFEST_URL = "https://dots.dunkirk.sh/services.json";
const KV_KEY = "services_manifest";

export async function getManifest(env: Env): Promise<ServicesManifest> {
	const [res, existing] = await Promise.all([
		fetch(MANIFEST_URL),
		env.KV.get(KV_KEY),
	]);
	if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);

	const serialized = JSON.stringify(await res.json());

	// Only write to KV if the manifest changed
	if (serialized !== existing) {
		await env.KV.put(KV_KEY, serialized);
	}

	return JSON.parse(serialized);
}
