/**
 * Unit tests cho withTimeout (HTTP body-read timeout helper).
 * Run: `bun test`
 *
 * Regression: AbortSignal.timeout của fetch không abort tin cậy body consumption
 * trong Bun (arrayBuffer/text/json) — server drip-feed body hang tool vĩnh viễn.
 * withTimeout dùng Promise.race để đảm bảo return.
 */

import { describe, expect, test } from "bun:test";
import { withTimeout } from "../src/http.ts";

describe("withTimeout", () => {
	test("returns value khi promise resolve trước timeout", async () => {
		const result = await withTimeout(Promise.resolve("ok"), 1000, "test");
		expect(result).toBe("ok");
	});

	test("rejects với timeout error khi promise không settle (regression: hang)", async () => {
		const never = new Promise<string>(() => {
			// intentionally never resolves — mô phỏng slowloris body drip-feed
		});
		await expect(withTimeout(never, 50, "hang body")).rejects.toThrow(
			/hang body timed out after 50ms/,
		);
	});

	test("propagates rejection gốc nếu promise reject trước timeout", async () => {
		await expect(
			withTimeout(Promise.reject(new Error("network")), 1000, "test"),
		).rejects.toThrow("network");
	});

	test("timer không chặn process sau khi resolve sớm (gc-friendly)", async () => {
		// Resolve ngay lập tức — withTimeout phải clear timer nội bộ,
		// không để setTimeout chạy lủng lẳng đến hết ms.
		const result = await withTimeout(Promise.resolve(42), 10_000, "fast");
		expect(result).toBe(42);
	});

	test("default label khi không truyền", async () => {
		await expect(
			withTimeout(new Promise<string>(() => {}), 30),
		).rejects.toThrow(/operation timed out after 30ms/);
	});
});
