/**
 * Tests cho D19 retry/remind verdict phòng thủ.
 * Run: `bun test`
 */
import { describe, expect, test } from "bun:test";
import {
	buildVerdictReminder,
	MAX_SESSION_RETRIES,
	MAX_VERDICT_REMINDS,
	waitForStreamingIdle,
} from "../src/pi.ts";
import {
	createInitialToolState,
	type ReviewToolState,
} from "../src/tools/index.ts";

describe("D19 constants", () => {
	test("MAX_SESSION_RETRIES = 2 (3 total attempts)", () => {
		expect(MAX_SESSION_RETRIES).toBe(2);
	});
	test("MAX_VERDICT_REMINDS = 2 (3 total turns per session)", () => {
		expect(MAX_VERDICT_REMINDS).toBe(2);
	});
});

describe("buildVerdictReminder — include state → next step", () => {
	test("no summary → remind post_summary first", () => {
		const state: ReviewToolState = { ...createInitialToolState() };
		const r = buildVerdictReminder(state);
		expect(r).toContain("summary posted: NO");
		expect(r).toContain("Next step: call post_summary(markdown)");
	});

	test("summary posted, 0 critical → remind approve_mr", () => {
		const state: ReviewToolState = {
			...createInitialToolState(),
			summaryPosted: true,
			criticalCount: 0,
			inlineCommentsPosted: 3,
		};
		const r = buildVerdictReminder(state);
		expect(r).toContain("summary posted: yes");
		expect(r).toContain("critical comments: 0");
		expect(r).toContain("Next step: call approve_mr(rationale)");
	});

	test("summary posted, >0 critical → remind request_changes (block approve)", () => {
		const state: ReviewToolState = {
			...createInitialToolState(),
			summaryPosted: true,
			criticalCount: 2,
		};
		const r = buildVerdictReminder(state);
		expect(r).toContain("critical comments: 2");
		expect(r).toContain("Next step: call request_changes(reason)");
		expect(r).toContain("2 critical issue(s) block approval");
	});

	test("always tells AI to stop other tool calls + issue verdict", () => {
		const r = buildVerdictReminder(createInitialToolState());
		expect(r).toContain("Do NOT call any other tool");
		expect(r).toContain("Issue the verdict immediately");
	});
});

describe("waitForStreamingIdle — fix MR !17 race", () => {
	test("returns immediately khi isStreaming=false", async () => {
		const session = { isStreaming: false };
		const start = Date.now();
		await waitForStreamingIdle(session, 1000);
		expect(Date.now() - start).toBeLessThan(50);
	});

	test("polls cho đến khi isStreaming=false", async () => {
		let calls = 0;
		const session = {
			get isStreaming() {
				calls++;
				return calls < 3; // false ở lần check thứ 3
			},
		};
		await waitForStreamingIdle(session, 2000);
		expect(calls).toBeGreaterThanOrEqual(3);
	});

	test("throws timeout khi isStreaming stuck true", async () => {
		const session = { isStreaming: true };
		// ponytail: poll interval 100ms, timeout 250ms → ~2-3 checks
		await expect(waitForStreamingIdle(session, 250)).rejects.toThrow(
			"session still streaming",
		);
	});
});
