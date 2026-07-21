/**
 * Tests cho mrContextFromEnv + repoDir (CI-job mode context).
 * Run: `bun test`
 */
import { describe, expect, test } from "bun:test";
import {
	mrContextFromEnv,
	ContextError,
	repoDir,
	enrichShaFromMr,
} from "../src/context.ts";
import type { MergeRequestObjectAttributes } from "../src/types.ts";
import type { MrContext } from "../src/gitlab.ts";

const FULL_ENV: Record<string, string | undefined> = {
	CI_PROJECT_ID: "100",
	CI_MERGE_REQUEST_IID: "42",
	CI_PROJECT_PATH: "acme/demo",
	CI_PROJECT_URL: "https://gitlab.com/acme/demo",
	CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feat/login",
	CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
	CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "abc123def",
	CI_MERGE_REQUEST_TARGET_BRANCH_SHA: "fed654cba",
	CI_COMMIT_SHA: "defaultcommitsha",
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

	test("sourceSha falls back to CI_COMMIT_SHA when *_SOURCE_BRANCH_SHA missing (D18)", () => {
		const { CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: _s, ...env } = FULL_ENV;
		const ctx = mrContextFromEnv({ ...env, CI_COMMIT_SHA: "fallbackhead" });
		expect(ctx.sourceSha).toBe("fallbackhead");
	});

	test("sourceSha prefers CI_MERGE_REQUEST_SOURCE_BRANCH_SHA when both set", () => {
		const ctx = mrContextFromEnv({
			...FULL_ENV,
			CI_COMMIT_SHA: "fallbackhead",
		});
		expect(ctx.sourceSha).toBe("abc123def");
	});

	test("targetSha falls back to CI_MERGE_REQUEST_DIFF_BASE_SHA when *_TARGET_BRANCH_SHA missing (D18)", () => {
		const { CI_MERGE_REQUEST_TARGET_BRANCH_SHA: _t, ...env } = FULL_ENV;
		const ctx = mrContextFromEnv({
			...env,
			CI_MERGE_REQUEST_DIFF_BASE_SHA: "fallbackbase",
		});
		expect(ctx.targetSha).toBe("fallbackbase");
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

// ─── enrichShaFromMr (D21 — defense-in-depth SHA resolve) ────────────────
// Regression: postDiffNote block toàn bộ inline comments với cùng error khi
// CI_MERGE_REQUEST_*_BRANCH_SHA + CI_MERGE_REQUEST_DIFF_BASE_SHA đều empty
// → targetSha undefined. Fix: enrich từ fetchMr().diff_refs.

function mrFixture(
	diffRefs?: { base_sha: string; head_sha: string; start_sha: string },
): MergeRequestObjectAttributes {
	return {
		iid: 42,
		title: "feat: x",
		state: "opened",
		action: "open",
		draft: false,
		source_branch: "feat/x",
		target_branch: "main",
		source_project_id: 1,
		target_project_id: 1,
		url: "https://gitlab.example/acme/demo/-/merge_requests/42",
		diff_refs: diffRefs,
	};
}

function ctxFixture(overrides: Partial<MrContext> = {}): MrContext {
	return {
		projectId: 1,
		mrIid: 42,
		projectPath: "acme/demo",
		sourceBranch: "feat/x",
		targetBranch: "main",
		title: "",
		description: "",
		webUrl: "https://gitlab.example/acme/demo/-/merge_requests/42",
		...overrides,
	};
}

describe("enrichShaFromMr — D21 defense-in-depth SHA", () => {
	test("enrich sourceSha + targetSha khi undefined, từ diff_refs (base/head)", () => {
		const ctx = ctxFixture({ sourceSha: undefined, targetSha: undefined });
		const mr = mrFixture({
			base_sha: "baseABC",
			head_sha: "headXYZ",
			start_sha: "baseABC",
		});
		const res = enrichShaFromMr(ctx, mr);
		expect(ctx.sourceSha).toBe("headXYZ");
		expect(ctx.targetSha).toBe("baseABC");
		expect(res).toEqual({
			sourceShaChanged: true,
			targetShaChanged: true,
		});
	});

	test("KHÔNG override SHA đã set — CI env ưu tiên (layer order)", () => {
		const ctx = ctxFixture({ sourceSha: "envSrc", targetSha: "envTgt" });
		const mr = mrFixture({
			base_sha: "baseABC",
			head_sha: "headXYZ",
			start_sha: "baseABC",
		});
		const res = enrichShaFromMr(ctx, mr);
		expect(ctx.sourceSha).toBe("envSrc");
		expect(ctx.targetSha).toBe("envTgt");
		expect(res).toEqual({
			sourceShaChanged: false,
			targetShaChanged: false,
		});
	});

	test("diff_refs undefined → no-op, no mutation", () => {
		const ctx = ctxFixture({ sourceSha: undefined, targetSha: undefined });
		const mr = mrFixture(undefined);
		const res = enrichShaFromMr(ctx, mr);
		expect(ctx.sourceSha).toBeUndefined();
		expect(ctx.targetSha).toBeUndefined();
		expect(res).toEqual({
			sourceShaChanged: false,
			targetShaChanged: false,
		});
	});

	test("partial enrich — chỉ targetSha undefined, sourceSha đã set", () => {
		const ctx = ctxFixture({ sourceSha: "envSrc", targetSha: undefined });
		const mr = mrFixture({
			base_sha: "baseABC",
			head_sha: "headXYZ",
			start_sha: "baseABC",
		});
		const res = enrichShaFromMr(ctx, mr);
		expect(ctx.sourceSha).toBe("envSrc");
		expect(ctx.targetSha).toBe("baseABC");
		expect(res).toEqual({
			sourceShaChanged: false,
			targetShaChanged: true,
		});
	});
});
