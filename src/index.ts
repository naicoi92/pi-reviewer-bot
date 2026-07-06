#!/usr/bin/env bun
/**
 * CLI entrypoint (CI-job mode, D1-revised).
 *
 * Đọc context từ GitLab CI predefined env vars → load `.pi/config.yaml` →
 * `performReview` → `emitStatsLine` → exit code. Không còn HTTP server.
 *
 * Exit-code contract:
 *   0 = review ok (approved HOẶC changes_requested — intentional block, job vẫn pass)
 *   1 = review fail (error/inconclusive) → MR blocked, user re-run pipeline
 */

import { mrContextFromEnv, repoDir } from "./context.ts";
import { loadConfig } from "./config.ts";
import { performReview, type ReviewOutcome } from "./review.ts";
import { emitStatsLine } from "./stats.ts";

async function main(): Promise<number> {
	// Legacy guards — warn, không fail (compat window cho user chưa clean env).
	if (process.env.WEBHOOK_SECRET) {
		console.warn("WEBHOOK_SECRET still set — webhook mode removed, delete it");
	}

	// Auth guard: GITLAB_API_TOKEN MUST là Project Access Token / user PAT,
	// KHÔNG phải CI_JOB_TOKEN (chỉ đọc được MR endpoints, không approve/note được).
	if (
		process.env.GITLAB_API_TOKEN &&
		process.env.GITLAB_API_TOKEN === process.env.CI_JOB_TOKEN
	) {
		console.error(
			"GITLAB_API_TOKEN === CI_JOB_TOKEN — job token cannot approve MRs or post notes. Use a Project Access Token or user PAT (scope api, role approver).",
		);
		return 1;
	}

	let ctx;
	try {
		ctx = mrContextFromEnv();
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		return 1;
	}

	const cfg = await loadConfig(repoDir());
	const t0 = Date.now();
	const outcome: ReviewOutcome = await performReview(ctx, cfg);
	emitStatsLine(ctx, outcome, Date.now() - t0);
	return outcome.ok ? 0 : 1;
}

main().then((code) => process.exit(code));
