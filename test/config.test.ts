/**
 * Tests cho config schema: ReviewLimits + drop ci.* + warn legacy.
 * Run: `bun test`
 */
import { describe, expect, test, spyOn } from "bun:test";
import { mergeConfig } from "../src/config.ts";

describe("mergeConfig — review.limits", () => {
	test("defaults include review.limits (maxToolCalls=30, timeoutMs=900000)", () => {
		const cfg = mergeConfig(undefined);
		expect(cfg.review.limits).toBeDefined();
		expect(cfg.review.limits?.maxToolCalls).toBe(30);
		expect(cfg.review.limits?.timeoutMs).toBe(900_000);
	});

	test("parses review.limits override", () => {
		const cfg = mergeConfig({
			review: { limits: { maxToolCalls: 50, timeoutMs: 600_000 } },
		});
		expect(cfg.review.limits?.maxToolCalls).toBe(50);
		expect(cfg.review.limits?.timeoutMs).toBe(600_000);
	});

	test("rejects invalid limits — negative/float falls back to default", () => {
		const cfg = mergeConfig({
			review: { limits: { maxToolCalls: -5, timeoutMs: 1.5 } },
		});
		expect(cfg.review.limits?.maxToolCalls).toBe(30);
		expect(cfg.review.limits?.timeoutMs).toBe(900_000);
	});
});

describe("mergeConfig — ci.* removed", () => {
	test("default config has no ci field", () => {
		const cfg = mergeConfig(undefined) as unknown as { ci?: unknown };
		expect(cfg.ci).toBeUndefined();
	});

	test("ci.* legacy ignored + warned", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const cfg = mergeConfig({
			ci: { require: true, waitTimeoutMs: 999 },
		}) as unknown as { ci?: unknown };
		expect(cfg.ci).toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("mergeConfig — kept sections", () => {
	test("review/scope/block/llm still parse", () => {
		const cfg = mergeConfig({
			review: { language: "en", skipTitleRegex: "wip" },
			scope: { enabled: true, convention: "feat/T-*" },
			block: { enabled: true },
			llm: { model: "zai/glm-5.2" },
		});
		expect(cfg.review.language).toBe("en");
		expect(cfg.review.skipTitleRegex).toBe("wip");
		expect(cfg.scope.enabled).toBe(true);
		expect(cfg.scope.convention).toBe("feat/T-*");
		expect(cfg.block.enabled).toBe(true);
		expect(cfg.llm.model).toBe("zai/glm-5.2");
	});
});
