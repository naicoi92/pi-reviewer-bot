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
