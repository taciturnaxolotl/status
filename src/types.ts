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
	triage_url: string | null;
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

export interface Incident {
	id: number;
	service_id: string;
	title: string;
	status: "investigating" | "identified" | "monitoring" | "resolved";
	severity: "critical" | "major" | "minor";
	triage_report: string | null;
	github_repo: string | null;
	github_issue_number: number | null;
	started_at: number;
	resolved_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface IncidentUpdate {
	id: number;
	incident_id: number;
	status: string;
	message: string;
	created_at: number;
}

export interface IncidentWithUpdates extends Incident {
	updates: IncidentUpdate[];
}

export interface Env {
	DB: D1Database;
	KV: KVNamespace;
	TAILSCALE_API_KEY?: string;
	TRIAGE_AUTH_TOKEN?: string;
	GITHUB_TOKEN?: string;
	GITHUB_ASSIGNEE?: string;
}
