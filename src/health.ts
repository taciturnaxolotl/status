import type { Service } from "./types";

interface HealthResult {
	status: "up" | "degraded" | "down";
	latency_ms: number;
}

export async function checkHealth(service: Service): Promise<HealthResult> {
	if (!service.health_url) {
		return { status: "unknown" as "down", latency_ms: 0 };
	}

	const start = Date.now();
	try {
		const res = await fetch(service.health_url, {
			method: "GET",
			signal: AbortSignal.timeout(10_000),
			redirect: "follow",
		});
		const latency_ms = Date.now() - start;

		if (res.status >= 200 && res.status < 300) {
			return { status: "up", latency_ms };
		}
		if (res.status >= 500) {
			return { status: "degraded", latency_ms };
		}
		return { status: "down", latency_ms };
	} catch {
		return { status: "down", latency_ms: Date.now() - start };
	}
}
