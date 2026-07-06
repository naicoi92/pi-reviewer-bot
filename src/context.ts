/**
 * CI-job mode context: build MrContext từ GitLab CI predefined env vars.
 *
 * Khác webhook mode (mrContextFromWebhook đọc payload): CI env vars chính xác.
 * Title/description không có trong CI env → rỗng, performReview enrich qua fetchMr().
 * SHA resolve qua fallback (D18) vì CI_MERGE_REQUEST_*_BRANCH_SHA unreliable.
 *
 * Token + GitLab host KHÔNG nằm ở đây — gitlab.ts đọc `GITLAB_API_TOKEN` +
 * `GITLAB_URL` (derive từ `CI_API_V4_URL` nếu self-hosted).
 */

import type { MrContext } from "./gitlab.ts";

/**
 * Required CI predefined env vars cho review job.
 *
 * KHÔNG include `CI_MERGE_REQUEST_*_BRANCH_SHA` — known GitLab bug: empty trong
 * detached / merged-result pipelines (D18). SHA resolve qua fallback ở dưới.
 */
const REQUIRED_ENV = [
	"CI_PROJECT_ID",
	"CI_MERGE_REQUEST_IID",
	"CI_PROJECT_PATH",
	"CI_PROJECT_URL",
	"CI_MERGE_REQUEST_SOURCE_BRANCH_NAME",
	"CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
	"CI_COMMIT_SHA",
] as const;

/** Lỗi thiếu/gặp giá trị sai CI env var — fail fast (exit 1 ở caller). */
export class ContextError extends Error {
	constructor(public varName: string) {
		super(`Missing or invalid CI env var: ${varName}`);
		this.name = "ContextError";
	}
}

/**
 * Build MrContext từ GitLab CI predefined env vars.
 *
 * @throws {ContextError} nếu thiếu required var hoặc projectId/iid không phải số.
 */
export function mrContextFromEnv(
	env: Record<string, string | undefined> = process.env,
): MrContext {
	for (const k of REQUIRED_ENV) {
		if (!env[k]) throw new ContextError(k);
	}

	const projectId = Number(env.CI_PROJECT_ID);
	const mrIid = Number(env.CI_MERGE_REQUEST_IID);
	if (!Number.isInteger(projectId) || projectId <= 0)
		throw new ContextError("CI_PROJECT_ID (not a positive integer)");
	if (!Number.isInteger(mrIid) || mrIid <= 0)
		throw new ContextError("CI_MERGE_REQUEST_IID (not a positive integer)");

	return {
		projectId,
		mrIid,
		projectPath: env.CI_PROJECT_PATH as string,
		sourceBranch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME as string,
		targetBranch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME as string,
		// D18: CI_MERGE_REQUEST_*_BRANCH_SHA unreliable (empty trong detached /
		// merged-result pipelines). Fallback CI_COMMIT_SHA (luôn set, = source
		// HEAD trong MR pipeline) + CI_MERGE_REQUEST_DIFF_BASE_SHA (merge base).
		sourceSha: env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA ?? env.CI_COMMIT_SHA,
		targetSha:
			env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA ??
			env.CI_MERGE_REQUEST_DIFF_BASE_SHA,
		// CI env không có title/description → rỗng, performReview enrich qua fetchMr.
		title: "",
		description: "",
		webUrl: `${env.CI_PROJECT_URL}/-/merge_requests/${mrIid}`,
	};
}

/**
 * Repo dir cho fetch_file tool: CI runner checkout sẵn vào process.cwd().
 * LOCAL_REPO_PATH override cho debug ngoài CI.
 */
export function repoDir(
	env: Record<string, string | undefined> = process.env,
): string {
	return env.LOCAL_REPO_PATH ?? process.cwd();
}
