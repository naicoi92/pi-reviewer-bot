/**
 * Tool factory — builds 12 tools cho AI reviewer (Mức 3 full tool).
 *
 * Tools chia sẻ state qua `ToolContext` object. State mutation qua tools
 * để bot có thể post-check sau khi AI chạy xong (fail-safe approve/unapprove).
 */

import type { MrContext } from "../gitlab.ts";
import type { MergeRequestDiffEntry } from "../types.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fetchFileTool } from "./fetch_file.ts";
import { postSummaryTool } from "./post_summary.ts";
import { postInlineCommentTool } from "./post_inline_comment.ts";
import { approveMrTool } from "./approve_mr.ts";
import { requestChangesTool } from "./request_changes.ts";
import { getIssueTool } from "./get_issue.ts";
import { listMrCommentsTool } from "./list_mr_comments.ts";
import { listMrCommitsTool } from "./list_mr_commits.ts";
import { getWikiPageTool } from "./get_wiki_page.ts";
import { listWikiPagesTool } from "./list_wiki_pages.ts";
import { webSearchTool } from "./web_search.ts";
import { fetchUrlsTool } from "./fetch_urls.ts";
import { getSearchContentTool } from "./get_search_content.ts";

/**
 * Mutable state shared giữa các tools trong 1 review session.
 * Bot đọc state này sau khi AI chạy xong để quyết định fail-safe action.
 */
export interface ReviewToolState {
	/** True sau khi AI gọi post_summary. Cần = true trước khi approve_mr. */
	summaryPosted: boolean;
	/** Số inline comment với severity=critical. Phải = 0 trước khi approve_mr. */
	criticalCount: number;
	/** True sau khi AI gọi approve_mr thành công. */
	approved: boolean;
	/** True sau khi AI gọi request_changes. */
	changesRequested: boolean;
	/** Tổng số tool calls (chống spam). */
	toolCallCount: number;
	/** Summary text đã post (cho bot log + fail-safe comment). */
	summaryText: string;
	/** Lý do request_changes (nếu có). */
	changesReason: string;
	/** Số inline comments đã post (cho stats). */
	inlineCommentsPosted: number;
	/** True sau khi Exa fail 1 lần — skip Exa cho mọi web_search call sau (dùng DDG). Giảm 401 spam. */
	exaFailed: boolean;
}

export interface ToolContext {
	mrContext: MrContext;
	repoDir: string;
	diffEntries: MergeRequestDiffEntry[];
	state: ReviewToolState;
	/** Max tool calls/review (purged từ env — từ cfg.review.limits.maxToolCalls). */
	maxToolCalls: number;
}

export function createInitialToolState(): ReviewToolState {
	return {
		summaryPosted: false,
		criticalCount: 0,
		approved: false,
		changesRequested: false,
		toolCallCount: 0,
		summaryText: "",
		changesReason: "",
		inlineCommentsPosted: 0,
		exaFailed: false,
	};
}

/** Wrap each tool's execute to count calls + cap total. */
type AnyTool = ToolDefinition<any, any, any>;

function withCallCount(tool: AnyTool, ctx: ToolContext): AnyTool {
	const original = tool.execute.bind(tool);
	return {
		...tool,
		async execute(...args: Parameters<typeof original>) {
			ctx.state.toolCallCount += 1;
			if (ctx.state.toolCallCount > ctx.maxToolCalls) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Tool call cap reached (${ctx.maxToolCalls}). Stop calling tools and post your summary now.`,
						},
					],
					details: {} as never,
				};
			}
			return original(...args);
		},
	} as AnyTool;
}

/** Build all 12 tools for a review session. */
export function createReviewTools(ctx: ToolContext): AnyTool[] {
	return [
		// Read tools (no state mutation)
		withCallCount(fetchFileTool(ctx), ctx),
		withCallCount(getIssueTool(ctx), ctx),
		withCallCount(listMrCommentsTool(ctx), ctx),
		withCallCount(listMrCommitsTool(ctx), ctx),
		withCallCount(listWikiPagesTool(ctx), ctx),
		withCallCount(getWikiPageTool(ctx), ctx),
		withCallCount(webSearchTool(ctx), ctx),
		withCallCount(fetchUrlsTool(ctx), ctx),
		withCallCount(getSearchContentTool(ctx), ctx),
		// Write tools (state mutation + GitLab API)
		withCallCount(postSummaryTool(ctx), ctx),
		withCallCount(postInlineCommentTool(ctx), ctx),
		withCallCount(approveMrTool(ctx), ctx),
		withCallCount(requestChangesTool(ctx), ctx),
	];
}
