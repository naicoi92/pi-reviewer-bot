/**
 * HTTP body-read timeout helper.
 *
 * `AbortSignal.timeout()` (truyền vào fetch) abort tin cậy connection + headers,
 * NHƯNG Bun KHÔNG abort tin cậy body consumption đang diễn ra (arrayBuffer/text/json).
 * Server gửi headers nhanh rồi drip-feed body (slowloris-style) → tool hang vĩnh viễn.
 *
 * `withTimeout` race promise đọc body against hard timeout — đảm bảo tool return
 * ngay cả khi underlying socket vẫn mở. Trạng thái socket sẽ được GC dọn sau.
 */

/**
 * Race một promise gegen hard timeout. Clear timer khi promise settle.
 *
 * @param p Promise cần race (vd `resp.arrayBuffer()`, `resp.text()`, `resp.json()`).
 * @param ms Timeout milliseconds.
 * @param label Label cho error message (vd "fetch_url body").
 * @throws {Error} `{label} timed out after {ms}ms` nếu `p` không settle trong `ms`.
 */
export async function withTimeout<T>(
	p: Promise<T>,
	ms: number,
	label = "operation",
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
