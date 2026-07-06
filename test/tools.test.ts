/**
 * Tool registration tests — verify createReviewTools exposes đúng 13 tools.
 * Run: `bun test`
 */

import { describe, expect, test } from "bun:test";
import {
	createReviewTools,
	createInitialToolState,
	type ToolContext,
} from "../src/tools/index.ts";
import type { MrContext } from "../src/gitlab.ts";
import type { MergeRequestDiffEntry } from "../src/types.ts";

function makeCtx(): ToolContext {
	const mrContext = {
		projectId: 100,
		mrIid: 1,
		projectPath: "acme/demo",
		sourceBranch: "feat/x",
		targetBranch: "main",
		title: "test",
		description: "",
		webUrl: "https://gitlab.com/acme/demo/-/merge_requests/1",
	} as MrContext;
	return {
		mrContext,
		repoDir: "/tmp/fake",
		diffEntries: [] as MergeRequestDiffEntry[],
		state: createInitialToolState(),
		maxToolCalls: 30,
	};
}

describe("createReviewTools registration", () => {
	test("registers exactly 13 tools", () => {
		const tools = createReviewTools(makeCtx());
		expect(tools.length).toBe(13);
	});

	test("includes web_search + fetch_urls + get_search_content", () => {
		const tools = createReviewTools(makeCtx());
		const names = tools.map((t) => t.name).sort();
		expect(names).toContain("web_search");
		expect(names).toContain("fetch_urls");
		expect(names).toContain("get_search_content");
	});

	test("tool set matches expected registry", () => {
		const tools = createReviewTools(makeCtx());
		const expected = [
			// Read
			"fetch_files",
			"get_issue",
			"list_mr_comments",
			"list_mr_commits",
			"list_wiki_pages",
			"get_wiki_page",
			"web_search",
			"fetch_urls",
			"get_search_content",
			// Write
			"post_summary",
			"post_inline_comment",
			"approve_mr",
			"request_changes",
		].sort();
		expect(tools.map((t) => t.name).sort()).toEqual(expected);
	});
});
