export interface Service {
	name: string;
	description: string;
	domain: string;
	health_url: string | null;
	port: number;
	repository: string;
	runtime: string;
	data: {
		files: string[];
		postgres: string | null;
		sqlite: string | null;
	};
}

export type ServicesManifest = Service[];

export interface StatusResponse {
	ok: boolean;
	services: {
		id: string;
		name: string;
		status: "up" | "degraded" | "down" | "unknown";
		latency_ms: number | null;
		uptime_7d: number;
	}[];
}

export interface UptimeResponse {
	service_id: string;
	window_hours: number;
	buckets: {
		timestamp: number;
		status: "up" | "degraded" | "down";
	}[];
}

export interface Env {
	DB: D1Database;
	KV: KVNamespace;
}
