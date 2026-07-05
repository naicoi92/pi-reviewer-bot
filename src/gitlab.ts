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
  MergeRequestWebhook,
} from "./types.ts";

const API_TOKEN = process.env.GITLAB_API_TOKEN ?? "";
const GITLAB_URL = process.env.GITLAB_URL ?? "https://gitlab.com";

if (!API_TOKEN) {
  console.warn("[gitlab] GITLAB_API_TOKEN not set — bot will fail to post comments");
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

/** Extract API-relevant fields from a webhook payload. */
export function mrContextFromWebhook(payload: MergeRequestWebhook): MrContext {
  const mr = payload.object_attributes;
  return {
    projectId: mr.target_project_id,
    mrIid: mr.iid,
    projectPath: payload.project.path_with_namespace,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    sourceSha: mr.source_branch_sha,
    targetSha: mr.target_branch_sha,
    title: mr.title,
    description: mr.description ?? "",
    webUrl: mr.url,
  };
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

/**
 * Convenience: build a clone URL with the token embedded.
 * Format: `https://oauth2:<token>@gitlab.com/group/project.git`
 *
 * Note: callers should NEVER log the returned URL — use redactToken() for logs.
 */
export function authenticatedCloneUrl(project: {
  git_http_url: string;
}): string {
  const url = new URL(project.git_http_url);
  url.username = "oauth2";
  url.password = API_TOKEN;
  return url.toString();
}

/** Redact any `oauth2:xxx@` or `token@` from a URL/string for safe logging. */
export function redactToken(s: string): string {
  return s
    .replace(/(oauth2:)[^@]+@/gi, "$1***@")
    .replace(/(token=)[^&\s]+/gi, "$1***")
    .replace(/glpat-[A-Za-z0-9_-]+/g, "glpat-***");
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

/**
 * Approve the MR. Optionally pin to a specific commit SHA so the
 * approval is invalidated automatically when new commits are pushed
 * (GitLab resets approvals on push by default for the bot too).
 */
export async function approveMr(
  ctx: MrContext,
  sha?: string,
): Promise<{ ok: boolean; error?: string }> {
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
 * Unapprove the MR (revokes any prior bot approval).
 * Idempotent: returns ok=true if there was no approval to remove.
 */
export async function unapproveMr(
  ctx: MrContext,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${API_BASE}/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}/approve`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: authHeaders(),
  });
  // 405 = no approval to remove (GitLab responds 405 Method Not Allowed
  // for "no approval" in some versions; 404 in others). Treat as success.
  if (!res.ok && res.status !== 405 && res.status !== 404) {
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
      error: "Missing sourceSha/targetSha in MR context — cannot post inline comment",
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
  notes?: Array<{ body: string; author: { username: string }; created_at: string; system: boolean }>;
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
      fetch(`${issueUrl}/notes?per_page=50&sort=asc`, { headers: authHeaders() }),
      fetch(`${issueUrl}/related_merge_requests`, { headers: authHeaders() }),
    ]);
    if (!issueRes.ok) {
      return { ok: false, error: `issue ${issueRes.status}: ${await issueRes.text()}` };
    }
    const issue = (await issueRes.json()) as GitLabIssue;
    // notes — ignore if 404 (older GitLab)
    if (notesRes.ok) {
      const notes = (await notesRes.json()) as GitLabIssue["notes"];
      issue.notes = Array.isArray(notes) ? notes.filter((n) => !n.system) : [];
    }
    if (relatedRes.ok) {
      issue.related_merge_requests = (await relatedRes.json()) as GitLabIssue["related_merge_requests"];
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
): Promise<{ ok: true; pages: WikiPageSummary[] } | { ok: false; error: string }> {
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
