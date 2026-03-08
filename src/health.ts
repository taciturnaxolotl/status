import type { Service } from "./types";

const SLOW_THRESHOLD_MS = 3000;

export type Status = "up" | "degraded" | "misconfigured" | "timeout" | "down" | "unknown";

interface HealthResult {
	status: Status;
	latency_ms: number;
}

export async function checkHealth(service: Service): Promise<HealthResult> {
	if (!service.health_url) {
		return { status: "unknown", latency_ms: 0 };
	}

	const start = Date.now();
	try {
		const res = await fetch(service.health_url, {
			method: "GET",
			signal: AbortSignal.timeout(10_000),
			redirect: "follow",
		});
		const latency_ms = Date.now() - start;

		if (res.status >= 400 && res.status < 500) {
			return { status: "misconfigured", latency_ms };
		}
		if (res.status === 502 || res.status === 504) {
			return { status: "down", latency_ms };
		}
		if (res.status >= 500) {
			return { status: "degraded", latency_ms };
		}
		if (res.status >= 200 && res.status < 300) {
			if (latency_ms > SLOW_THRESHOLD_MS) {
				return { status: "degraded", latency_ms };
			}
			return { status: "up", latency_ms };
		}
		return { status: "down", latency_ms };
	} catch (err) {
		const latency_ms = Date.now() - start;
		const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
		return { status: isTimeout ? "timeout" : "down", latency_ms };
	}
}
