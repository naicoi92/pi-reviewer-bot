/**
 * Tests cho mrContextFromEnv + repoDir (CI-job mode context).
 * Run: `bun test`
 */
import { describe, expect, test } from "bun:test";
import { mrContextFromEnv, ContextError, repoDir } from "../src/context.ts";

const FULL_ENV: Record<string, string | undefined> = {
	CI_PROJECT_ID: "100",
	CI_MERGE_REQUEST_IID: "42",
	CI_PROJECT_PATH: "acme/demo",
	CI_PROJECT_URL: "https://gitlab.com/acme/demo",
	CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feat/login",
	CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
	CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "abc123def",
	CI_MERGE_REQUEST_TARGET_BRANCH_SHA: "fed654cba",
};

describe("mrContextFromEnv", () => {
	test("full env → MrContext", () => {
		const ctx = mrContextFromEnv(FULL_ENV);
		expect(ctx.projectId).toBe(100);
		expect(ctx.mrIid).toBe(42);
		expect(ctx.projectPath).toBe("acme/demo");
		expect(ctx.sourceBranch).toBe("feat/login");
		expect(ctx.targetBranch).toBe("main");
		expect(ctx.sourceSha).toBe("abc123def");
		expect(ctx.targetSha).toBe("fed654cba");
		expect(ctx.webUrl).toBe("https://gitlab.com/acme/demo/-/merge_requests/42");
	});

	test("title/description empty — enriched by fetchMr in performReview", () => {
		const ctx = mrContextFromEnv(FULL_ENV);
		expect(ctx.title).toBe("");
		expect(ctx.description).toBe("");
	});

	test("throws ContextError naming the missing var", () => {
		const { CI_PROJECT_ID: _omit, ...noProjectId } = FULL_ENV;
		expect(() => mrContextFromEnv(noProjectId)).toThrow(ContextError);
		expect(() => mrContextFromEnv(noProjectId)).toThrow(/CI_PROJECT_ID/);
	});

	test("throws on non-numeric projectId/iid", () => {
		expect(() =>
			mrContextFromEnv({ ...FULL_ENV, CI_PROJECT_ID: "abc" }),
		).toThrow(ContextError);
	});

	test("sourceSha optional var missing still ok (targetSha optional)", () => {
		const { CI_MERGE_REQUEST_TARGET_BRANCH_SHA: _t, ...env } = FULL_ENV;
		const ctx = mrContextFromEnv(env);
		expect(ctx.targetSha).toBeUndefined();
	});
});

describe("repoDir", () => {
	test("LOCAL_REPO_PATH override", () => {
		expect(repoDir({ LOCAL_REPO_PATH: "/tmp/repo" })).toBe("/tmp/repo");
	});

	test("falls back to process.cwd()", () => {
		expect(repoDir({})).toBe(process.cwd());
	});
});
