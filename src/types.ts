/**
 * GitLab Merge Request webhook payload types.
 *
 * Source: https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#merge-request-events
 * Verified schema as of 2026-07. Only fields the bot actually uses are typed.
 */

export type GitLabEventKind =
  | "merge_request"
  | "push"
  | "note"
  | "pipeline"
  | "build"
  | string;

// ─── Pipeline (CI) ───────────────────────────────────────────
// Used by CI wait mode — bot listens for pipeline webhooks to know when CI
// finishes, then triggers deferred review. Docs:
// https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#pipeline-events

/**
 * Trạng thái pipeline theo GitLab API.
 *
 * Phân loại cho CI wait logic (xem `src/webhook.ts:performReview`):
 * - `RUNNING_STATES` (running|pending|created|waiting_for_resource|preparing|
 *   scheduled|manual|new): CI chưa xong → bot enqueue đợi.
 * - `SUCCESS` (`success`): CI pass → review luôn.
 * - `FAILURE_STATES` (failed|canceled|skipped): CI fail → skip review + note.
 */
export type PipelineStatus =
  | "created"
  | "waiting_for_resource"
  | "preparing"
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "canceled"
  | "skipped"
  | "manual"
  | "scheduled"
  | "new";

/** Tập status coi như "CI đang chạy" — bot sẽ đợi. */
export const PIPELINE_RUNNING_STATES = new Set<PipelineStatus>([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);

/** Tập status coi như "CI fail" — bot skip review + post note. */
export const PIPELINE_FAILURE_STATES = new Set<PipelineStatus>([
  "failed",
  "canceled",
  "skipped",
]);

export interface PipelineObjectAttributes {
  id: number;
  ref: string;
  /** Status of the pipeline at the moment webhook fired. */
  status: PipelineStatus;
  /** Commit SHA the pipeline ran against. */
  sha: string;
  /** "branch" | "tag" — usually branch cho MR pipeline. */
  source?: string;
  // NOTE: `project_id` KHÔNG nằm trong `object_attributes` của pipeline webhook
  // (fix BUG 7). GitLab đặt project ID ở top-level `project.id` (xem docs:
  // https://docs.gitlab.com/development/webhooks/). Dùng `resolvePipelineProjectId`
  // trong gitlab.ts để resolve — KHÔNG đọc trực tiếp từ đây.
}

export interface PipelineWebhook {
  object_kind: "pipeline";
  event_type: "pipeline";
  user: GitLabUser;
  project: GitLabProject;
  /** Commit metadata pipeline ran on. */
  commit: { id: string; message: string; timestamp: string };
  object_attributes: PipelineObjectAttributes;
  /** MRs attached to this pipeline (present khi pipeline trigger từ MR push). */
  merge_request?: {
    id: number;
    iid: number;
    source_branch: string;
    target_branch: string;
    source_project_id: number;
    target_project_id: number;
    state: MergeRequestState;
  };
  builds: Array<{
    id: number;
    stage: string;
    name: string;
    status: PipelineStatus;
    created_at: string;
  }>;
}

export interface GitLabUser {
  id: number;
  name: string;
  username: string;
  email?: string;
  avatar_url?: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  namespace: string;
  web_url: string;
  homepage?: string;
  git_http_url: string;
  git_ssh_url: string;
  http_url?: string;
  ssh_url?: string;
  default_branch: string;
  url?: string;
  visibility_level: number;
}

export type MergeRequestAction =
  | "open"
  | "close"
  | "reopen"
  | "update"
  | "merge"
  | "approved"
  | "unapproved"
  | "approval"
  | "unapproval"
  | "mark_as_draft"
  | "unmark_as_draft";

export type MergeRequestState = "opened" | "closed" | "merged" | "locked";

export interface LastCommit {
  id: string;
  message: string;
  timestamp: string;
  url: string;
  author: {
    name: string;
    email: string;
  };
}

export interface MergeRequestObjectAttributes {
  iid: number;
  /** Number visible in URL — same as iid in most cases. */
  number?: number;
  title: string;
  description?: string;
  state: MergeRequestState;
  action: MergeRequestAction;
  draft: boolean;
  /** Legacy alias for `draft`. */
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  source_branch_sha?: string;
  target_branch_sha?: string;
  merge_commit_sha?: string | null;
  merge_status?: string;
  detailed_merge_status?: string;
  url: string;
  last_commit?: LastCommit;
  source?: GitLabProject;
  target?: GitLabProject;
}

export interface MergeRequestLabel {
  id: number;
  title: string;
  color: string;
  project_id: number;
}

/** Previous + current value for a changed field on `update` events. */
export interface ChangeEntry<T> {
  previous: T | null;
  current: T | null;
}

export interface MergeRequestChanges {
  last_commit?: ChangeEntry<LastCommit | null>;
  title?: ChangeEntry<string>;
  description?: ChangeEntry<string>;
  source_branch?: ChangeEntry<string>;
  target_branch?: ChangeEntry<string>;
  draft?: ChangeEntry<boolean>;
  labels?: ChangeEntry<MergeRequestLabel[]>;
}

/** Top-level webhook body for object_kind = "merge_request". */
export interface MergeRequestWebhook {
  object_kind: "merge_request";
  event_type: "merge_request";
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: MergeRequestObjectAttributes;
  labels: MergeRequestLabel[];
  changes: MergeRequestChanges;
  assignees?: GitLabUser[];
  reviewers?: GitLabUser[];
}

/** Generic shape we accept on POST /webhook — kinds other than MR are skipped. */
export interface AnyGitLabWebhook {
  object_kind: GitLabEventKind;
  [key: string]: unknown;
}

/** One entry from GET /projects/:id/merge_requests/:iid/diffs. */
export interface MergeRequestDiffEntry {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}

/** Outcome of Pi review run. */
export interface ReviewResult {
  ok: boolean;
  markdown: string;
  /** Raw events from Pi SDK events, kept for debugging. */
  eventCount: number;
  error?: string;
  durationMs: number;
}
