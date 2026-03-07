import type { Env, UptimeResponse } from "../types";
import { getUptimeBuckets } from "../db";

export async function handleUptime(
	env: Env,
	serviceId: string,
	url: URL,
): Promise<Response> {
	const windowParam = url.searchParams.get("window");
	const window_hours = windowParam ? parseInt(windowParam, 10) * 24 : 90 * 24;

	const buckets = await getUptimeBuckets(env.DB, serviceId, window_hours);

	return Response.json(
		{ service_id: serviceId, window_hours, buckets } satisfies UptimeResponse,
	);
}
