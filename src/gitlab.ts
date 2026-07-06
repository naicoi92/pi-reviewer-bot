/**
 * Thin GitLab REST API client.
 *
 * Uses `@gitbeaker/rest` for typed request/response. Auth via `GITLAB_API_TOKEN`
 * (Personal/Project Access Token, scope `api`).
 *
 * Endpoints used:
 *   - GET  /projects/:id/merge_requests/:iid/diffs   (fetch MR diff)
 *   - POST /projects/:id/merge_requests/:iid/notes   (post review comment)
 *   - GET  /projects/:id/merge_requests/:iid         (fetch MR metadata)
 *
 * Pagination: GitLab is migrating /diffs to keyset pagination. We follow
 * `x-next-page` header when present; otherwise stop after page 1.
 */

import { Gitlab } from "@gitbeaker/rest";
import type {
	MergeRequestDiffEntry,
	MergeRequestObjectAttributes,
} from "./types.ts";

const API_TOKEN = process.env.GITLAB_API_TOKEN ?? "";
// Self-hosted GitLab: derive host từ CI_API_V4_URL (CI predefined) nếu GITLAB_URL chưa set.
const GITLAB_URL =
	process.env.GITLAB_URL ??
	(process.env.CI_API_V4_URL
		? process.env.CI_API_V4_URL.replace(/\/api\/v4\/?$/i, "")
		: "https://gitlab.com");

if (!API_TOKEN) {
	console.warn(
		"[gitlab] GITLAB_API_TOKEN not set — bot will fail to post comments",
	);
}

/** Singleton gitbeaker client. Memoised. */
let cachedClient: InstanceType<typeof Gitlab> | undefined;
function client(): InstanceType<typeof Gitlab> {
	if (cachedClient) return cachedClient;
	cachedClient = new Gitlab({
		token: API_TOKEN,
		host: GITLAB_URL,
	});
	return cachedClient;
}

export interface MrContext {
	/** Target project ID (used for API calls — fork-safe). */
	projectId: number;
	mrIid: number;
	/** `group/subgroup/project` — used for human-readable logs + prompt. */
	projectPath: string;
	sourceBranch: string;
	targetBranch: string;
	/** Head SHA of source branch. May be missing on some payloads. */
	sourceSha?: string;
	targetSha?: string;
	title: string;
	description: string;
	webUrl: string;
}

/**
 * Fetch the unified diff of all files changed in the MR.
 *
 * Uses the (non-deprecated) `/diffs` endpoint. Caps total files at 100 to
 * keep prompt size sane; very large MRs should be reviewed by file chunks
 * (post-MVP).
 */
export async function fetchMrDiff(
	ctx: MrContext,
	maxFiles = 100,
): Promise<MergeRequestDiffEntry[]> {
	const api = client();
	const all: MergeRequestDiffEntry[] = [];
	let page = 1;
	const perPage = 50;

	while (all.length < maxFiles) {
		const res = (await api.MergeRequests.allDiffs(ctx.projectId, ctx.mrIid, {
			page,
			perPage,
		})) as MergeRequestDiffEntry[];

		if (!Array.isArray(res) || res.length === 0) break;
		all.push(...res);
		if (res.length < perPage) break; // last page
		page += 1;
	}

	return all.slice(0, maxFiles);
}

/**
 * Fetch MR metadata — for fields not present in the webhook payload
 * (e.g. full description when webhook truncates).
 */
export async function fetchMr(
	ctx: MrContext,
): Promise<MergeRequestObjectAttributes> {
	const api = client();
	const res = await api.MergeRequests.show(ctx.projectId, ctx.mrIid);
	return res as unknown as MergeRequestObjectAttributes;
}

/**
 * Post a top-level note (comment) on the MR.
 *
 * For inline line comments use the Discussions API with a `position` hash —
 * that is post-MVP.
 */
export async function postMrNote(
	ctx: MrContext,
	body: string,
): Promise<{ id: number } | { error: string }> {
	const api = client();
	try {
		const res = (await api.MergeRequestNotes.create(
			ctx.projectId,
			ctx.mrIid,
			body,
		)) as unknown as { id: number };
		return { id: res.id };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[gitlab] postMrNote failed for !${ctx.mrIid}:`, msg);
		return { error: msg };
	}
}

// ─── Approval gate ───────────────────────────────────────────
// Used to block merge until the bot approves. Pair with GitLab
// project Approval Rules that require the bot account as approver.
// Docs: https://docs.gitlab.com/api/merge_request_approvals/

const API_BASE = `${GITLAB_URL}/api/v4`;

function authHeaders(): Record<string, string> {
	return {
		"PRIVATE-TOKEN": API_TOKEN,
		"Content-Type": "application/json",
	};
}

/** Cache current user ID để check "bot đã approve chưa". */
let cachedBotUserId: number | null | undefined;

/**
 * Lấy ID của user sở hữu API token (bot user). Cache kết quả.
 * Trả null nếu không xác định được (token invalid / network fail).
 */
async function currentUserId(_ctx: MrContext): Promise<number | null> {
	if (cachedBotUserId !== undefined) return cachedBotUserId;
	try {
		const res = await fetch(`${API_BASE}/user`, {
			headers: authHeaders(),
		});
		if (!res.ok) {
			cachedBotUserId = null;
			return null;
		}
		const user = (await res.json()) as { id?: number };
		cachedBotUserId = typeof user.id === "number" ? user.id : null;
		return cachedBotUserId;
	} catch {
		cachedBotUserId = null;
		return null;
	}
}

/**
 * Lấy approval state của MR: danh sách user ID đã approve.
 * Dùng cho idempotency check (tránh approve lại MR đã approved → 401).
 */
async function fetchMrApprovalState(
	ctx: MrContext,
): Promise<{ ok: boolean; approvedBy: number[] }> {
	try {
		const res = await fetch(
			`${API_BASE}/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}/approvals`,
			{ headers: authHeaders() },
		);
		if (!res.ok) return { ok: false, approvedBy: [] };
		const data = (await res.json()) as {
			approved_by?: { user: { id: number } }[];
		};
		return {
			ok: true,
			approvedBy: (data.approved_by ?? []).map((a) => a.user.id),
		};
	} catch {
		return { ok: false, approvedBy: [] };
	}
}

/**
 * Approve the MR. Optionally pin to a specific commit SHA so the
 * approval is invalidated automatically when new commits are pushed
 * (GitLab resets approvals on push by default for the bot too).
 *
 * Idempotent: nếu bot đã approve SHA này rồi (kiểm qua GET /approvals),
 * trả ok=true ngay không gọi POST lại (GitLab trả 401 khi approve lại MR
 * đã approved bởi cùng user — approve không idempotent).
 */
export async function approveMr(
	ctx: MrContext,
	sha?: string,
): Promise<{ ok: boolean; error?: string }> {
	// Check approval state trước — tránh 401 khi approve lại MR đã approved.
	const state = await fetchMrApprovalState(ctx);
	if (state.ok) {
		const botId = await currentUserId(ctx);
		const alreadyApproved = botId != null && state.approvedBy.includes(botId);
		if (alreadyApproved) {
			return { ok: true };
		}
	}

	const url = `${API_BASE}/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}/approve`;
	const body = sha ? JSON.stringify({ sha }) : "{}";
	const res = await fetch(url, {
		method: "POST",
		headers: authHeaders(),
		body,
	});
	if (!res.ok) {
		const errText = await res.text();
		return { ok: false, error: `${res.status}: ${errText.slice(0, 200)}` };
	}
	return { ok: true };
}

/**
 * Unapprove the MR (revokes the current user's approval).
 * Endpoint: POST /merge_requests/:iid/unapprove (KHÔNG phải DELETE /approve).
 * Idempotent: 404/405 khi không có approval để gỡ → treat as success.
 */
export async function unapproveMr(
	ctx: MrContext,
): Promise<{ ok: boolean; error?: string }> {
	const url = `${API_BASE}/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}/unapprove`;
	const res = await fetch(url, {
		method: "POST",
		headers: authHeaders(),
	});
	// 404/405 = không có approval để gỡ (GitLab version-dependent).
	if (
		!res.ok &&
		res.status !== 404 &&
		res.status !== 405 &&
		res.status !== 409
	) {
		const errText = await res.text();
		return { ok: false, error: `${res.status}: ${errText.slice(0, 200)}` };
	}
	return { ok: true };
}

// ─── Inline DiffNote (line-specific comments) ────────────────
// Uses Discussions API with position hash — Notes API silently drops
// inline `position`. Docs: https://docs.gitlab.com/api/discussions/

export interface DiffNoteInput {
	/** Old path of the file (before the change). Use new_path if not renamed. */
	oldPath: string;
	/** New path of the file (after the change). */
	newPath: string;
	/** Line number in the NEW version of the file. */
	newLine: number;
	/** Comment body (markdown). */
	body: string;
}

export async function postDiffNote(
	ctx: MrContext,
	note: DiffNoteInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	// position requires base/head/start SHA. Source = head, target = base = start.
	if (!ctx.sourceSha || !ctx.targetSha) {
		return {
			ok: false,
			error:
				"Missing sourceSha/targetSha in MR context — cannot post inline comment",
		};
	}
	const url = `${API_BASE}/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}/discussions`;
	const res = await fetch(url, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			body: note.body,
			position: {
				base_sha: ctx.targetSha,
				head_sha: ctx.sourceSha,
				start_sha: ctx.targetSha,
				position_type: "text",
				new_path: note.newPath,
				old_path: note.oldPath,
				new_line: note.newLine,
			},
		}),
	});
	if (!res.ok) {
		const errText = await res.text();
		return { ok: false, error: `${res.status}: ${errText.slice(0, 300)}` };
	}
	const data = (await res.json()) as { id: string };
	return { ok: true, id: data.id };
}

// ─── Read-only context fetchers ──────────────────────────────
// Tools let AI pull extra context for scope alignment + idempotency.

export interface GitLabIssue {
	iid: number;
	title: string;
	description: string | null;
	state: "opened" | "closed";
	labels: string[];
	milestone: { title: string } | null;
	assignees: Array<{ username: string }>;
	web_url: string;
	/** Linked MRs (issues/:iid/related_merge_requests). */
	related_merge_requests?: Array<{ iid: number; title: string; state: string }>;
	/** Comments / discussions on the issue. */
	notes?: Array<{
		body: string;
		author: { username: string };
		created_at: string;
		system: boolean;
	}>;
}

/** Read a GitLab issue by IID + its comments + linked MRs. */
export async function getIssue(
	projectId: number,
	issueIid: number,
): Promise<{ ok: true; issue: GitLabIssue } | { ok: false; error: string }> {
	try {
		const issueUrl = `${API_BASE}/projects/${projectId}/issues/${issueIid}`;
		const [issueRes, notesRes, relatedRes] = await Promise.all([
			fetch(issueUrl, { headers: authHeaders() }),
			fetch(`${issueUrl}/notes?per_page=50&sort=asc`, {
				headers: authHeaders(),
			}),
			fetch(`${issueUrl}/related_merge_requests`, { headers: authHeaders() }),
		]);
		if (!issueRes.ok) {
			return {
				ok: false,
				error: `issue ${issueRes.status}: ${await issueRes.text()}`,
			};
		}
		const issue = (await issueRes.json()) as GitLabIssue;
		// notes — ignore if 404 (older GitLab)
		if (notesRes.ok) {
			const notes = (await notesRes.json()) as GitLabIssue["notes"];
			issue.notes = Array.isArray(notes) ? notes.filter((n) => !n.system) : [];
		}
		if (relatedRes.ok) {
			issue.related_merge_requests =
				(await relatedRes.json()) as GitLabIssue["related_merge_requests"];
		}
		return { ok: true, issue };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export interface MrComment {
	id: number;
	body: string;
	author: { username: string };
	created_at: string;
	system: boolean;
	/** True if part of a resolved thread. */
	resolved?: boolean;
}

/** List top-level notes on the MR — for idempotent review. */
export async function listMrComments(
	ctx: MrContext,
): Promise<{ ok: true; comments: MrComment[] } | { ok: false; error: string }> {
	const url = `${API_BASE}/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}/notes?per_page=100&sort=asc`;
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) {
		return { ok: false, error: `${res.status}: ${await res.text()}` };
	}
	const data = (await res.json()) as MrComment[];
	// Filter out system notes (auto-generated: "changed milestone", "assigned to X")
	return { ok: true, comments: data.filter((c) => !c.system) };
}

export interface MrCommit {
	id: string;
	short_id: string;
	title: string;
	message: string;
	author_name: string;
	authored_date: string;
}

/** List commits in the MR — for tracing iteration history. */
export async function listMrCommits(
	ctx: MrContext,
): Promise<{ ok: true; commits: MrCommit[] } | { ok: false; error: string }> {
	const url = `${API_BASE}/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}/commits?per_page=100`;
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) {
		return { ok: false, error: `${res.status}: ${await res.text()}` };
	}
	return { ok: true, commits: (await res.json()) as MrCommit[] };
}

export interface WikiPage {
	slug: string;
	title: string;
	content: string;
	format: "markdown" | "asciidoc" | "rdoc";
}

export interface WikiPageSummary {
	slug: string;
	title: string;
	format: string;
	created_at: string;
	updated_at?: string;
}

/** List wiki pages in project — for discovery (AI doesn't know slugs in advance). */
export async function listWikiPages(
	projectId: number,
): Promise<
	{ ok: true; pages: WikiPageSummary[] } | { ok: false; error: string }
> {
	const url = `${API_BASE}/projects/${projectId}/wikis?per_page=100&sort=asc`;
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) {
		return { ok: false, error: `${res.status}: ${await res.text()}` };
	}
	const data = (await res.json()) as WikiPageSummary[];
	return { ok: true, pages: data };
}

/** Read a GitLab project wiki page by slug. */
export async function getWikiPage(
	projectId: number,
	slug: string,
): Promise<{ ok: true; page: WikiPage } | { ok: false; error: string }> {
	const url = `${API_BASE}/projects/${projectId}/wikis/${encodeURIComponent(slug)}`;
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) {
		return { ok: false, error: `${res.status}: ${await res.text()}` };
	}
	const data = (await res.json()) as WikiPage;
	return { ok: true, page: data };
}
