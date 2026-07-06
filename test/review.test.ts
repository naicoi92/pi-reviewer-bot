/**
 * Tests cho deriveOutcome — exit-code contract (pure logic).
 * Run: `bun test`
 */
import { describe, expect, test } from "bun:test";
import { deriveOutcome } from "../src/review.ts";
import type { PiReviewResult } from "../src/pi.ts";
import type { ReviewToolState } from "../src/tools/index.ts";

const baseState: ReviewToolState = {
	summaryPosted: false,
	criticalCount: 0,
	approved: false,
	changesRequested: false,
	toolCallCount: 0,
	summaryText: "",
	changesReason: "",
	inlineCommentsPosted: 0,
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

	test("no verdict → inconclusive (job FAIL → MR blocked)", () => {
		expect(deriveOutcome(fakeResult({}))).toEqual({
			ok: false,
			reason: "inconclusive",
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
