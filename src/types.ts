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

export interface Machine {
	hostname: string;
	tailscale_host: string;
	type: "server" | "client";
	services: Service[];
}

export type ServicesManifest = Record<string, Machine>;

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
	TAILSCALE_API_KEY?: string;
}
