/**
 * Tests cho deriveOutcome — exit-code contract (pure logic).
 * Run: `bun test`
 */
import { describe, expect, test } from "bun:test";
import { deriveOutcome, shouldSkip } from "../src/review.ts";
import type { PiReviewResult } from "../src/pi.ts";
import type { ReviewToolState } from "../src/tools/index.ts";
import { DEFAULT_CONFIG, type ProjectConfig } from "../src/config.ts";

const baseState: ReviewToolState = {
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

function fakeResult(overrides: {
	ok?: boolean;
	error?: string;
	toolState?: Partial<ReviewToolState>;
}): PiReviewResult {
	return {
		ok: overrides.ok ?? true,
		markdown: "",
		eventCount: 0,
		error: overrides.error,
		durationMs: 100,
		toolState: { ...baseState, ...overrides.toolState },
	};
}

describe("shouldSkip — WIP/DNR filter", () => {
	test("default skipBranchRegex matches wip/ branch", () => {
		expect(shouldSkip(DEFAULT_CONFIG, "feat: add", "wip/login")).toBe(true);
	});
	test("default skipTitleRegex matches WIP title", () => {
		expect(shouldSkip(DEFAULT_CONFIG, "WIP: fix bug", "feat/x")).toBe(true);
	});
	test("no match → false", () => {
		expect(shouldSkip(DEFAULT_CONFIG, "feat: add login", "feat/login")).toBe(
			false,
		);
	});
	test("empty regex → never skip", () => {
		const cfg: ProjectConfig = {
			...DEFAULT_CONFIG,
			review: {
				...DEFAULT_CONFIG.review,
				skipTitleRegex: "",
				skipBranchRegex: "",
			},
		};
		expect(shouldSkip(cfg, "WIP anything", "wip/x")).toBe(false);
	});
});

describe("deriveOutcome — exit-code contract", () => {
	test("approved → ok:true (job pass, MR unblock)", () => {
		expect(
			deriveOutcome(fakeResult({ toolState: { approved: true } })),
		).toEqual({
			ok: true,
			verdict: "approved",
		});
	});

	test("changesRequested → ok:true changes_requested (job PASS, MR block intentional)", () => {
		expect(
			deriveOutcome(fakeResult({ toolState: { changesRequested: true } })),
		).toEqual({ ok: true, verdict: "changes_requested" });
	});

	test("no verdict → inconclusive (job PASS, MR blocked vì unapproved)", () => {
		expect(deriveOutcome(fakeResult({}))).toEqual({
			ok: true,
			verdict: "inconclusive",
		});
	});

	test("pi error → error outcome with detail (job FAIL → MR blocked)", () => {
		expect(deriveOutcome(fakeResult({ ok: false, error: "timeout" }))).toEqual({
			ok: false,
			reason: "error",
			detail: "timeout",
		});
	});

	test("approved takes precedence over changesRequested", () => {
		expect(
			deriveOutcome(
				fakeResult({ toolState: { approved: true, changesRequested: true } }),
			),
		).toEqual({ ok: true, verdict: "approved" });
	});
});
