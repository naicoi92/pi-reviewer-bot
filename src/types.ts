/**
 * MR data types (CI-job mode, D1-revised).
 *
 * Webhook payload types đã LOẠI BỎ: `MergeRequestWebhook`, `PipelineWebhook`,
 * `AnyGitLabWebhook`, `MergeRequestChanges`, `PipelineObjectAttributes`,
 * `PIPELINE_*` states, `PipelineStatus`, `GitLabEventKind`, `MergeRequestLabel`,
 * `ChangeEntry`, `GitLabUser`. Bot giờ đọc context từ GitLab CI predefined env
 * vars (`context.ts`), không consume webhook payload.
 *
 * Còn lại: MR object attributes (fetchMr return) + diff entry + review result.
 */

export type MergeRequestState = "opened" | "closed" | "merged" | "locked";

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

export interface GitLabProject {
	id: number;
	name: string;
	path: string;
	path_with_namespace: string;
	namespace: string;
	web_url: string;
	git_http_url: string;
	git_ssh_url: string;
	default_branch: string;
	visibility_level: number;
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
