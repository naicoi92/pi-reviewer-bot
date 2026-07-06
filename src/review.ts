/**
 * Review orchestration (CI-job mode). Port từ `webhook.ts:performReview`:
 *   - Entry: `(MrContext, ProjectConfig)` thay vì webhook payload.
 *   - Strip: ciwait (checkCiAndWait), inflight (registerReview/cancel),
 *     limiter (withLimits), clone (cloneForReview → repoDir).
 *   - Trả `ReviewOutcome` → `index.ts` map exit code.
 *
 * Logic derive outcome giữ nguyên (proven). Chỉ đổi entry + strip orchestration.
 */

import type { MrContext } from "./gitlab.ts";
import { fetchMr, fetchMrDiff, postMrNote, unapproveMr } from "./gitlab.ts";
import {
	runPiReview,
	MAX_SESSION_RETRIES,
	MAX_VERDICT_REMINDS,
	type PiReviewResult,
} from "./pi.ts";
import type { ProjectConfig } from "./config.ts";
import { repoDir } from "./context.ts";

export type ReviewOutcome =
	| { ok: true; verdict: "approved" | "changes_requested" | "skipped" }
	| { ok: false; reason: "inconclusive" | "error"; detail?: string };

/**
 * Derive ReviewOutcome từ PiReviewResult (pure, testable).
 *
 * Exit-code contract:
 *   approved / changes_requested → ok:true  (job PASS; changes_requested vẫn block MR — intentional)
 *   inconclusive / error         → ok:false (job FAIL → MR blocked, user re-run pipeline)
 */
export function deriveOutcome(result: PiReviewResult): ReviewOutcome {
	if (!result.ok) {
		return { ok: false, reason: "error", detail: result.error };
	}
	const ts = result.toolState;
	if (ts.approved) return { ok: true, verdict: "approved" };
	if (ts.changesRequested) return { ok: true, verdict: "changes_requested" };
	return { ok: false, reason: "inconclusive" };
}

/**
 * Project-level skip filter (WIP/DNR). CI `rules:` chỉ filter được branch (qua
 * `$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`), KHÔNG filter được title regex → bot
 * re-apply skip config sau khi enrich title qua fetchMr.
 */
export function shouldSkip(
	cfg: ProjectConfig,
	title: string,
	sourceBranch: string,
): boolean {
	if (
		cfg.review.skipBranchRegex &&
		new RegExp(cfg.review.skipBranchRegex).test(sourceBranch)
	) {
		return true;
	}
	if (
		cfg.review.skipTitleRegex &&
		new RegExp(cfg.review.skipTitleRegex).test(title)
	) {
		return true;
	}
	return false;
}

/**
 * Run one review.
 *
 * Flow: enrich title/description (CI env thiếu) → unapprove-if-block →
 * fetch diff → runPiReview → derive outcome → post note nếu fail.
 */
export async function performReview(
	ctx: MrContext,
	cfg: ProjectConfig,
): Promise<ReviewOutcome> {
	const log = (msg: string) => console.log(`[review !${ctx.mrIid}] ${msg}`);
	log(`start — ${ctx.projectPath} @ ${ctx.sourceBranch}`);
	const dir = repoDir();
	const startedAt = Date.now();

	try {
		// CI env không có title/description → enrich qua fetchMr (best-effort).
		try {
			const mr = await fetchMr(ctx);
			ctx.title = mr.title;
			ctx.description = mr.description ?? "";
		} catch (e) {
			log(`warn — fetchMr failed: ${e instanceof Error ? e.message : e}`);
		}

		// Skip WIP/DNR (project-level filter — CI rules không cover title regex).
		if (shouldSkip(cfg, ctx.title, ctx.sourceBranch)) {
			log(`skip — title/branch matches skipTitle/skipBranch regex`);
			return { ok: true, verdict: "skipped" };
		}

		// Revoke approval cũ (block=true) — MR blocked trong suốt review lại.
		// Idempotent: unapproveMr coi 404/405 (no approval) là success.
		if (cfg.block.enabled) {
			const r = await unapproveMr(ctx);
			log(
				r.ok
					? "unapproved (block=true)"
					: `warn — unapprove failed: ${r.error}`,
			);
		}

		const diffEntries = await fetchMrDiff(ctx);
		log(`fetched ${diffEntries.length} file diffs`);
		if (diffEntries.length === 0) {
			await postMrNote(
				ctx,
				"## 🤖 Review\n\nNo file changes detected — nothing to review.",
			).catch(() => void 0);
			return { ok: true, verdict: "skipped" };
		}

		const result = await runPiReview({
			ctx,
			repoDir: dir,
			diffEntries,
			model: cfg.llm.model,
			maxToolCalls: cfg.review.limits.maxToolCalls,
			timeoutMs: cfg.review.limits.timeoutMs,
		});
		log(
			`pi finished in ${result.durationMs}ms — ok=${result.ok} events=${result.eventCount}`,
		);

		const outcome = deriveOutcome(result);

		if (!outcome.ok) {
			if (cfg.block.enabled) await unapproveMr(ctx).catch(() => void 0);
			const body =
				outcome.reason === "inconclusive"
					? `## ⚠️ Review inconclusive\n\nBot finished review (after ${MAX_SESSION_RETRIES + 1} session retries + ${MAX_VERDICT_REMINDS} verdict reminds) but did not issue a verdict.\n\n**Summary:** ${result.toolState.summaryText || "(no summary posted)"}\n\n**Inline comments posted:** ${result.toolState.inlineCommentsPosted} (${result.toolState.criticalCount} critical). Đọc comments trong tab Changes để quyết định thủ công: merge nếu OK, hoặc fix + push lại nếu có critical chưa xử lý.\n\n_Inconclusive review blocks merge. Retry pi-review job, manually approve to override, hoặc push commit mới._`
					: `## 🤖 Review failed\n\n⚠️ **Bot error:** ${outcome.detail ?? "unknown"}\n\n_Merge blocked until bot succeeds. Retry pi-review job, manually approve to override._`;
			await postMrNote(ctx, body).catch(() => void 0);
		}

		return outcome;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[review !${ctx.mrIid}] error:`, msg);
		await postMrNote(
			ctx,
			`## 🤖 Review failed\n\n⚠️ **Bot error:** ${msg}\n\n_Bot will retry on next pipeline run._`,
		).catch(() => void 0);
		if (cfg.block.enabled) await unapproveMr(ctx).catch(() => void 0);
		return { ok: false, reason: "error", detail: msg };
	} finally {
		log(`done — duration=${Date.now() - startedAt}ms`);
	}
}
