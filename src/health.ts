import type { Service } from "./types";

const SLOW_THRESHOLD_MS = 3000;

// Workers allow 6 open connections per invocation and queue the rest, which would count queue time as latency.
const MAX_IN_FLIGHT = 5;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
	inFlight++;
	try {
		return await fn();
	} finally {
		inFlight--;
		waiting.shift()?.();
	}
}

export type Status = "up" | "degraded" | "misconfigured" | "timeout" | "down" | "unknown";

export interface HealthResult {
	status: Status;
	latency_ms: number;
	status_code?: number;
	error?: string;
}

export async function checkHealth(service: Service): Promise<HealthResult> {
	const url = service.health_url;
	if (!url) {
		return { status: "unknown", latency_ms: 0 };
	}
	return withSlot(() => probe(url));
}

async function probe(health_url: string): Promise<HealthResult> {
	const start = Date.now();
	try {
		const res = await fetch(health_url, {
			method: "GET",
			signal: AbortSignal.timeout(10_000),
			redirect: "follow",
		});
		const latency_ms = Date.now() - start;
		// Only the status code matters here. An unread body holds a slot in the
		// runtime's concurrent-fetch pool, and with ~20 services in flight it
		// cancels the oldest response to avoid deadlock, logging a warning each time.
		res.body?.cancel().catch(() => {});

		if (res.status >= 400 && res.status < 500) {
			return { status: "misconfigured", latency_ms, status_code: res.status };
		}
		if (res.status === 502 || res.status === 504) {
			return { status: "down", latency_ms, status_code: res.status };
		}
		if (res.status >= 500) {
			return { status: "degraded", latency_ms, status_code: res.status };
		}
		if (res.status >= 200 && res.status < 300) {
			if (latency_ms > SLOW_THRESHOLD_MS) {
				return { status: "degraded", latency_ms, status_code: res.status };
			}
			return { status: "up", latency_ms, status_code: res.status };
		}
		return { status: "down", latency_ms, status_code: res.status };
	} catch (err) {
		const latency_ms = Date.now() - start;
		const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
		const error = isTimeout ? "Request timed out after 10s" : err instanceof Error ? err.message : "Unknown error";
		return { status: isTimeout ? "timeout" : "down", latency_ms, error };
	}
}
