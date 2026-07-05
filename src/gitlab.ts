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
import {
  PIPELINE_FAILURE_STATES,
  PIPELINE_RUNNING_STATES,
} from "./types.ts";
import type {
  MergeRequestDiffEntry,
  MergeRequestObjectAttributes,
  MergeRequestWebhook,
  PipelineStatus,
  PipelineWebhook,
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

/**
 * Extract API-relevant fields from a webhook payload.
 *
 * **Quan trọng (fix BUG 5)**: `sourceSha` fallback `last_commit.id` khi
 * `source_branch_sha` không được gửi. GitLab không luôn gửi `source_branch_sha`
 * — vd `open`/`reopen` event trên nhiều bản self-managed chỉ có `last_commit`.
 *
 * Phải CONSISTENT với `ciwait.ts:enqueuePendingReview` và `inflight.ts:registerReview`
 * (cũng fallback `mr.source_branch_sha ?? mr.last_commit?.id`). Trước đây mỗi chỗ
 * resolve SHA khác nhau → `getMrPipelineStatus` filter theo SHA undefined → lấy
 * TẤT CẢ pipelines của MR (kể cả zombie cũ) → CI wait mode stuck "running".
 */
export function mrContextFromWebhook(payload: MergeRequestWebhook): MrContext {
  const mr = payload.object_attributes;
  return {
    projectId: mr.target_project_id,
    mrIid: mr.iid,
    projectPath: payload.project.path_with_namespace,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    sourceSha: mr.source_branch_sha ?? mr.last_commit?.id,
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

// ─── CI pipeline (cho CI wait mode) ──────────────────────────
// Bot có thể đợi CI pass trước khi review (cfg.ci.require=true).
// Hàm này lấy status pipeline mới nhất cho MR — dùng cho 2 mục đích:
//   1. Khi MR webhook đến → check xem CI đang chạy hay đã xong.
//   2. Khi pipeline webhook đến (status=success) → trigger pending review.
// Docs: https://docs.gitlab.com/api/merge_requests/#list-merge-request-pipelines

export interface MrPipelineEntry {
  id: number;
  sha: string;
  ref: string;
  status: PipelineStatus;
  /** "merged" | "pending" | "running" | ... — GitLab dùng 1 số field khác nhau cho "trạng thái tổng" */
  detailed_status?: unknown;
  /** "push" | "merge_request_event" | "scheduled" | "trigger" | ... —GitLab có thể chạy nhiều pipeline cho cùng push. */
  source?: string;
  created_at: string;
  updated_at: string;
  web_url: string;
}

/**
 * Aggregate trạng thái TẤT CẢ pipeline cùng SHA thành 1 status tổng.
 *
 * Pure function (không gọi API) — tách ra để test độc lập, không cần mock fetch.
 *
 * Rules:
 *   - Bất kỳ pipeline nào running/pending → "running" (bot phải đợi tất cả).
 *   - Tất cả success (hoặc manual) → "success".
 *   - Có failure + không còn running → failure status đó.
 *
 * Fix BUG 2: trước đây bot chỉ check `pipelines[0]` → miss fail của pipeline
 * khác cùng SHA (vd branch pipeline fail trong khi MR pipeline success).
 */
export function aggregatePipelineStatus(
  pipelines: MrPipelineEntry[],
): { hasPipeline: true; status: PipelineStatus; sha: string } | { hasPipeline: false } {
  if (pipelines.length === 0) return { hasPipeline: false };

  let anyRunning = false;
  let anyFailure: PipelineStatus | undefined;
  let allSuccess = true;
  let lastSha = "";

  for (const p of pipelines) {
    if (!p.status) continue;
    lastSha = p.sha;
    if (PIPELINE_RUNNING_STATES.has(p.status)) {
      anyRunning = true;
      allSuccess = false;
    } else if (PIPELINE_FAILURE_STATES.has(p.status)) {
      anyFailure = p.status;
      allSuccess = false;
    } else if (p.status !== "success" && p.status !== "manual") {
      // Status khác (vd skipped trong workflow rules) — coi không success.
      allSuccess = false;
    }
  }

  if (anyRunning) {
    return { hasPipeline: true, status: "running", sha: lastSha };
  }
  if (allSuccess) {
    return { hasPipeline: true, status: "success", sha: lastSha };
  }
  if (anyFailure) {
    return { hasPipeline: true, status: anyFailure, sha: lastSha };
  }
  // Edge case: toàn "manual" hoặc không status rõ → coi như success.
  return { hasPipeline: true, status: "success", sha: lastSha };
}

/**
 * Tổng hợp trạng thái CI cho commit đang review.
 *
 * **Quan trọng (fix BUG 2)**: GitLab có thể chạy **nhiều pipeline song song**
 * cho cùng 1 push — vd 1 branch pipeline (`source=push`) + 1 MR pipeline
 * (`source=merge_request_event`). Logic cũ chỉ check `pipelines[0]` → có thể
 * miss fail của pipeline kia.
 *
 * Logic:
 *   1. Lọc pipelines theo SHA = source SHA của MR (chỉ quan tâm commit đang review).
 *   2. Aggregate qua `aggregatePipelineStatus`.
 *
 * Trường hợp lỗi API (403/500/...) trả `{ hasPipeline: false, error }` — caller
 * tự decide (default: review anyway, lenient).
 */
export async function getMrPipelineStatus(
  ctx: MrContext,
): Promise<
  | { hasPipeline: true; status: PipelineStatus; sha: string }
  | { hasPipeline: false; error?: string }
> {
  try {
    const url = `${API_BASE}/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}/pipelines`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      // 404 thường gặp khi project chưa setup .gitlab-ci.yml → coi như "no pipeline"
      return { hasPipeline: false, error: `${res.status}` };
    }
    const all = (await res.json()) as MrPipelineEntry[];
    if (!Array.isArray(all) || all.length === 0) {
      return { hasPipeline: false };
    }

    // Chỉ xét pipelines cho commit đang review (source SHA).
    // GitLab list có thể bao gồm pipelines của commit cũ (vd sau rebase).
    //
    // **Quan trọng (fix BUG 5)**: nếu SHA undefined (webhook không gửi
    // source_branch_sha lẫn last_commit — edge case hiếm), filter sẽ miss.
    // Trước đây code fallback "lấy tất cả pipelines" → có thể include pipeline
    // cũ zombie running → aggregate return "running" → CI wait stuck.
    // Giờ: skip hoàn tất pipeline list cũ (only newest) — best-effort, log warn.
    const targetSha = ctx.sourceSha;
    let relevant: MrPipelineEntry[];
    if (targetSha) {
      relevant = all.filter((p) => p.sha === targetSha);
    } else {
      // Edge case: không có SHA để filter → chỉ lấy pipeline MỚI NHẤT (top of list,
      // GitLab sort by created_at desc). Tránh aggregate zombie pipeline cũ.
      console.warn(
        `[gitlab] getMrPipelineStatus cho !${ctx.mrIid}: sourceSha undefined — fallback newest pipeline only (may miss multi-pipeline aggregate)`,
      );
      relevant = all.slice(0, 1);
    }

    return aggregatePipelineStatus(relevant);
  } catch (e) {
    return { hasPipeline: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resolve project ID từ pipeline webhook payload.
 *
 * **Quan trọng (fix BUG 7)**: GitLab KHÔNG đặt `project_id` trong
 * `object_attributes` của pipeline webhook (như code cũ tưởng tượng) — mà đặt
 * ở **top-level** `project.id` (xem docs: https://docs.gitlab.com/development/webhooks/).
 *
 * Trước fix: `attrs?.project_id` → luôn `undefined` → bot skip mọi pipeline
 * webhook → CI wait mode stuck đến timeout 10 phút.
 *
 * Fallback chain (consistent với pattern resolve SHA `source_branch_sha ?? last_commit?.id`):
 *   1. `pipeline.project.id` — primary, luôn có theo docs GitLab
 *   2. `pipeline.merge_request.target_project_id` — fallback khi thiếu `project` block
 *
 * Pure function (không gọi API) — tách ra để test độc lập, không cần mock fetch.
 */
export function resolvePipelineProjectId(
  pipeline: PipelineWebhook,
): number | undefined {
  return pipeline.project?.id ?? pipeline.merge_request?.target_project_id;
}
