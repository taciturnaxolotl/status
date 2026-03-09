// GitHub Issues integration for incidents

import type { Incident } from "./types";
import { updateIncident, addIncidentUpdate } from "./db";

export function parseRepo(repoUrl: string): { owner: string; repo: string } | null {
	const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
	if (!match) return null;
	return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

export async function createIssue(
	token: string,
	owner: string,
	repo: string,
	opts: { title: string; body: string; assignees?: string[]; labels?: string[] },
): Promise<number> {
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "infra-status-worker",
		},
		body: JSON.stringify(opts),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub create issue failed: ${res.status} ${text}`);
	}
	const data = await res.json<{ number: number }>();
	return data.number;
}

export async function commentOnIssue(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<void> {
	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "infra-status-worker",
			},
			body: JSON.stringify({ body }),
		},
	);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub comment failed: ${res.status} ${text}`);
	}
}

export async function closeIssue(
	token: string,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<void> {
	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
		{
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "infra-status-worker",
			},
			body: JSON.stringify({ state: "closed" }),
		},
	);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub close issue failed: ${res.status} ${text}`);
	}
}

interface GitHubIssue {
	state: string;
	body: string | null;
}

interface GitHubComment {
	id: number;
	body: string;
	created_at: string;
	user: { login: string; type: string };
}

async function fetchIssue(token: string, owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "infra-status-worker",
		},
	});
	if (!res.ok) throw new Error(`GitHub fetch issue failed: ${res.status}`);
	return res.json();
}

async function fetchComments(token: string, owner: string, repo: string, issueNumber: number, since?: string): Promise<GitHubComment[]> {
	let url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=50`;
	if (since) url += `&since=${since}`;
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "infra-status-worker",
		},
	});
	if (!res.ok) throw new Error(`GitHub fetch comments failed: ${res.status}`);
	return res.json();
}

export async function syncGitHubIncidents(
	db: D1Database,
	kv: KVNamespace,
	token: string,
	incidents: Incident[],
): Promise<void> {
	for (const incident of incidents) {
		if (!incident.github_repo || !incident.github_issue_number) continue;

		const parsed = parseRepo(`https://github.com/${incident.github_repo}`);
		if (!parsed) continue;

		try {
			// Check issue state (closed = resolved) and sync body edits
			const issue = await fetchIssue(token, parsed.owner, parsed.repo, incident.github_issue_number);
			if (issue.state === "closed" && incident.status !== "resolved") {
				const now = Math.floor(Date.now() / 1000);
				// Fetch latest comments to find the closing message
				const kvKey = `gh_sync:${incident.id}:last`;
				const lastSeen = await kv.get(kvKey);
				const comments = await fetchComments(token, parsed.owner, parsed.repo, incident.github_issue_number, lastSeen ?? undefined);
				const human = comments.filter((c) => c.user.type !== "Bot" && !c.body.startsWith("Automated incident detected") && !c.body.startsWith("## Triage Report") && !c.body.startsWith("Service recovered automatically"));

				// Use the last human comment as the resolve message, or fall back to generic
				const resolveMsg = human.length > 0 ? human[human.length - 1].body : "Issue closed on GitHub";

				// Add any earlier human comments as investigating updates
				for (const comment of human.slice(0, -1)) {
					await addIncidentUpdate(db, incident.id, "investigating", comment.body);
				}

				await updateIncident(db, incident.id, { status: "resolved", resolved_at: now });
				await addIncidentUpdate(db, incident.id, "resolved", resolveMsg);

				// Track sync position (bump by 1s since GitHub's `since` is inclusive)
				if (comments.length > 0) {
					const latest = new Date(new Date(comments[comments.length - 1].created_at).getTime() + 1000).toISOString();
					await kv.put(kvKey, latest, { expirationTtl: 86400 * 7 });
				}
				continue;
			}

			// Sync new comments since last check
			const kvKey = `gh_sync:${incident.id}:last`;
			const lastSeen = await kv.get(kvKey);
			const comments = await fetchComments(token, parsed.owner, parsed.repo, incident.github_issue_number, lastSeen ?? undefined);

			// Filter to human comments only (skip bots and our own posts)
			const human = comments.filter((c) => c.user.type !== "Bot" && !c.body.startsWith("Automated incident detected") && !c.body.startsWith("## Triage Report") && !c.body.startsWith("Service recovered automatically"));

			for (const comment of human) {
				await addIncidentUpdate(db, incident.id, incident.status, comment.body);
			}

			// Track last comment time so we don't re-import (bump by 1s since GitHub's `since` is inclusive)
			if (comments.length > 0) {
				const latest = new Date(new Date(comments[comments.length - 1].created_at).getTime() + 1000).toISOString();
				await kv.put(kvKey, latest, { expirationTtl: 86400 * 7 });
			}
		} catch (_) {} // best effort, don't block other syncs
	}
}
