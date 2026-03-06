import type { Env } from "./types";

interface TailscaleDevice {
	hostname: string;
	connectedToControl: boolean;
	lastSeen: string;
	os: string;
}

const KV_KEY = "tailscale_devices";

export async function refreshDevices(env: Env): Promise<void> {
	if (!env.TAILSCALE_API_KEY) return;

	const res = await fetch(
		"https://api.tailscale.com/api/v2/tailnet/-/devices?fields=default",
		{
			headers: {
				Authorization: `Bearer ${env.TAILSCALE_API_KEY}`,
			},
		},
	);

	if (!res.ok) return;

	const data: { devices: TailscaleDevice[] } = await res.json();
	await env.KV.put(KV_KEY, JSON.stringify(data.devices));
}

export async function getDeviceStatus(
	env: Env,
	hostname: string,
): Promise<boolean> {
	const cached = await env.KV.get(KV_KEY, "json");
	if (!cached) return false;
	const devices = cached as TailscaleDevice[];
	const device = devices.find(
		(d) => d.hostname.toLowerCase() === hostname.toLowerCase(),
	);
	return device?.connectedToControl ?? false;
}
