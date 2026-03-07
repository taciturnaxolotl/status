const serviceStatusEnum = {
	type: "string",
	enum: ["up", "degraded", "misconfigured", "timeout", "down", "unknown"],
} as const;

const machineStatusEnum = {
	type: "string",
	enum: ["up", "degraded", "partial", "down", "unknown"],
} as const;

const service = {
	type: "object",
	properties: {
		id: { type: "string" },
		status: serviceStatusEnum,
		latency_ms: { type: ["number", "null"] },
		uptime_7d: { type: "number" },
	},
	required: ["id", "status", "latency_ms", "uptime_7d"],
	additionalProperties: false,
} as const;

const machine = {
	type: "object",
	properties: {
		name: { type: "string" },
		hostname: { type: "string" },
		type: { type: "string" },
		online: { type: "boolean" },
		status: machineStatusEnum,
		services: { type: "array", items: service },
	},
	required: ["name", "hostname", "type", "online", "status", "services"],
	additionalProperties: false,
} as const;

export const schemas: Record<string, object> = {
	status: {
		$schema: "http://json-schema.org/draft-07/schema#",
		title: "Status",
		description: "GET /api/status",
		type: "object",
		properties: {
			ok: { type: "boolean" },
			status: machineStatusEnum,
			machines: { type: "array", items: machine },
		},
		required: ["ok", "status", "machines"],
		additionalProperties: false,
		$defs: { service, machine, serviceStatus: serviceStatusEnum, machineStatus: machineStatusEnum },
	},

	"status-overall": {
		$schema: "http://json-schema.org/draft-07/schema#",
		title: "StatusOverall",
		description: "GET /api/status/overall",
		type: "object",
		properties: {
			ok: { type: "boolean" },
			status: machineStatusEnum,
			uptime_7d: { type: "number" },
			services_total: { type: "integer" },
			services_monitored: { type: "integer" },
			machines_total: { type: "integer" },
		},
		required: ["ok", "status", "uptime_7d", "services_total", "services_monitored", "machines_total"],
		additionalProperties: false,
	},

	"status-service": {
		$schema: "http://json-schema.org/draft-07/schema#",
		title: "StatusService",
		description: "GET /api/status/service/:id",
		type: "object",
		properties: {
			id: { type: "string" },
			status: serviceStatusEnum,
			latency_ms: { type: ["number", "null"] },
			uptime_7d: { type: "number" },
		},
		required: ["id", "status", "latency_ms", "uptime_7d"],
		additionalProperties: false,
	},

	"status-machine": {
		$schema: "http://json-schema.org/draft-07/schema#",
		title: "StatusMachine",
		description: "GET /api/status/machine/:name",
		type: "object",
		properties: {
			name: { type: "string" },
			hostname: { type: "string" },
			type: { type: "string" },
			online: { type: "boolean" },
			status: machineStatusEnum,
			services: { type: "array", items: service },
		},
		required: ["name", "hostname", "type", "online", "status", "services"],
		additionalProperties: false,
	},

	uptime: {
		$schema: "http://json-schema.org/draft-07/schema#",
		title: "Uptime",
		description: "GET /api/uptime/:service_id",
		type: "object",
		properties: {
			service_id: { type: "string" },
			window_hours: { type: "integer" },
			buckets: {
				type: "array",
				items: {
					type: "object",
					properties: {
						timestamp: { type: "string", format: "date-time" },
						status: serviceStatusEnum,
					},
					required: ["timestamp", "status"],
					additionalProperties: false,
				},
			},
		},
		required: ["service_id", "window_hours", "buckets"],
		additionalProperties: false,
	},

	error: {
		$schema: "http://json-schema.org/draft-07/schema#",
		title: "Error",
		description: "Error response (e.g. 404)",
		type: "object",
		properties: {
			error: { type: "string" },
		},
		required: ["error"],
		additionalProperties: false,
	},
};
