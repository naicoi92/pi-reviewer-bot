/**
 * Stats — CI-job mode. Bỏ HTTP `/stats` endpoint + in-memory collector
 * (D1-revised: không còn long-running server). Emit 1 JSON line/review lên
 * stdout — CI log là consumer. Parse được bằng `jq`, không丢 observability.
 */

import type { MrContext } from "./gitlab.ts";
import type { ReviewOutcome } from "./review.ts";

/**
 * Emit 1 JSON line tóm tắt review lên stdout.
 * Trường tối thiểu: project, mrIid, sourceSha, outcome, durationMs, timestamp.
 */
export function emitStatsLine(
	ctx: MrContext,
	outcome: ReviewOutcome,
	durationMs: number,
): void {
	const line = {
		project: ctx.projectPath,
		mrIid: ctx.mrIid,
		sourceSha: ctx.sourceSha,
		outcome: outcome.ok ? outcome.verdict : outcome.reason,
		durationMs,
		timestamp: new Date().toISOString(),
	};
	console.log(JSON.stringify(line));
}
