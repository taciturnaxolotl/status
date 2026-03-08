import type { Env } from "../types";
import {
  getActiveIncidents,
  getRecentIncidents,
  getIncident,
  createIncident,
  updateIncident,
  addIncidentUpdate,
} from "../db";
import { commentOnIssue, editIssueBody, parseRepo } from "../github";

function authCheck(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  if (!auth || !env.TRIAGE_AUTH_TOKEN) return false;
  return auth === `Bearer ${env.TRIAGE_AUTH_TOKEN}`;
}

export async function handleIncidentRoute(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  // GET /api/incidents
  if (path === "/api/incidents" && request.method === "GET") {
    const active = await getActiveIncidents(env.DB);
    const recent = await getRecentIncidents(env.DB, 7);
    const resolved = recent.filter((i) => i.status === "resolved");
    return Response.json({ active, recent_resolved: resolved });
  }

  // POST /api/incidents
  if (path === "/api/incidents" && request.method === "POST") {
    if (!authCheck(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const body = await request.json<{ service_id: string; title: string; severity: "critical" | "major" | "minor" }>();
    if (!body.service_id || !body.title || !body.severity) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }
    const id = await createIncident(env.DB, body);
    return Response.json({ id }, { status: 201 });
  }

  // GET /api/incidents/:id
  const singleMatch = path.match(/^\/api\/incidents\/(\d+)$/);
  if (singleMatch && request.method === "GET") {
    const incident = await getIncident(env.DB, parseInt(singleMatch[1]));
    if (!incident) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(incident);
  }

  // PATCH /api/incidents/:id
  if (singleMatch && request.method === "PATCH") {
    if (!authCheck(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const id = parseInt(singleMatch[1]);
    const body = await request.json<{ status?: string; triage_report?: string }>();
    const updateData: { status?: string; triage_report?: string; resolved_at?: number } = {};
    if (body.status) updateData.status = body.status;
    if (body.triage_report !== undefined) updateData.triage_report = body.triage_report;
    if (body.status === "resolved") updateData.resolved_at = Math.floor(Date.now() / 1000);
    await updateIncident(env.DB, id, updateData);
    if (body.status) {
      await addIncidentUpdate(env.DB, id, body.status, body.triage_report ?? `Status changed to ${body.status}`);
    }

    // Sync triage report to GitHub issue
    const incident = await getIncident(env.DB, id);
    if (env.GITHUB_TOKEN && incident?.github_repo && incident.github_issue_number) {
      const parsed = parseRepo(`https://github.com/${incident.github_repo}`);
      if (parsed) {
        if (body.triage_report) {
          // Post triage report as comment and update issue body
          commentOnIssue(env.GITHUB_TOKEN, parsed.owner, parsed.repo, incident.github_issue_number, `## Triage Report\n\n${body.triage_report}`).catch(() => {});
          editIssueBody(env.GITHUB_TOKEN, parsed.owner, parsed.repo, incident.github_issue_number, body.triage_report).catch(() => {});
        } else if (body.status) {
          commentOnIssue(env.GITHUB_TOKEN, parsed.owner, parsed.repo, incident.github_issue_number, `Status changed to **${body.status}**`).catch(() => {});
        }
      }
    }

    return Response.json({ ok: true });
  }

  // POST /api/incidents/:id/updates
  const updatesMatch = path.match(/^\/api\/incidents\/(\d+)\/updates$/);
  if (updatesMatch && request.method === "POST") {
    if (!authCheck(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const body = await request.json<{ status: string; message: string }>();
    if (!body.status || !body.message) {
      return Response.json({ error: "missing fields" }, { status: 400 });
    }
    await addIncidentUpdate(env.DB, parseInt(updatesMatch[1]), body.status, body.message);
    return Response.json({ ok: true }, { status: 201 });
  }

  return null;
}
