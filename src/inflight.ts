/**
 * In-flight review coordinator — cancel review cũ khi review mới bắt đầu.
 *
 * **Fix BUG 3**: Khi review SHA=a đang chạy (30s-5 phút) mà dev push SHA=b,
 * `performReview(SHA=b)` chạy song song với review cũ → 2 review đụng độ:
 *   - Wasted token AI review commit cũ
 *   - Inline comment có thể bị GitLab reject (diff position hash không match)
 *   - Race condition giữa 2 review cùng approve/unapprove
 *
 * Cơ chế: register review mới → nếu có review cũ cho cùng `projectId:mrIid` →
 * trigger abort signal của review cũ → `session.abort()` → SDK reject →
 * performReview catch AbortError → return không post note/approve.
 *
 * State lưu in-memory (Map). Trade-off: mất khi bot restart (cùng pattern
 * như CI wait — user push retry).
 *
 * Key là `projectId:mrIid` — 2 MR khác nhau không abort lẫn nhau (chỉ cùng MR
 * mới cancel).
 */

import type { MergeRequestWebhook } from "./types.ts";

export interface InFlightReview {
  mrIid: number;
  projectId: number;
  sha: string;
  /** Caller truyền vào `runPiReview({ abortSignal })` để Pi có thể abort session. */
  abortController: AbortController;
  startedAt: number;
}

/** Singleton Map — toàn bộ bot dùng chung 1 instance. */
const inflight = new Map<string, InFlightReview>();

function key(projectId: number, mrIid: number): string {
  return `${projectId}:${mrIid}`;
}

/**
 * Register review mới. **Quan trọng**: nếu có review cũ đang chạy cho cùng MR IID,
 * abort nó TRƯỚC KHI set entry mới. Tránh 2 review chạy song song.
 *
 * @returns `InFlightReview` mới — caller dùng `.abortController.signal` truyền
 *          vào `runPiReview()`.
 */
export function registerReview(payload: MergeRequestWebhook): InFlightReview {
  const mr = payload.object_attributes;
  const projectId = mr.target_project_id;
  const mrIid = mr.iid;
  const k = key(projectId, mrIid);

  // Abort review cũ nếu có (chưa completeReview).
  // abortController.abort() → Pi SDK session.abort() → performReview catch AbortError.
  const existing = inflight.get(k);
  if (existing) {
    existing.abortController.abort();
  }

  const entry: InFlightReview = {
    mrIid,
    projectId,
    sha: mr.source_branch_sha ?? mr.last_commit?.id ?? "",
    abortController: new AbortController(),
    startedAt: Date.now(),
  };
  inflight.set(k, entry);
  return entry;
}

/**
 * Abort review đang chạy cho MR. Idempotent — no-op nếu không có entry.
 * Returns `true` nếu có entry bị abort.
 */
export function abortReview(projectId: number, mrIid: number): boolean {
  const entry = inflight.get(key(projectId, mrIid));
  if (!entry) return false;
  entry.abortController.abort();
  inflight.delete(key(projectId, mrIid));
  return true;
}

/**
 * Clear entry khi review xong (无论 success hay fail). Bắt buộc gọi trong
 * `finally` của `performReview` để entry không leak + không abort nhầm
 * review kế tiếp (register của review kế tiếp chỉ abort khi entry cũ còn).
 */
export function completeReview(projectId: number, mrIid: number): void {
  inflight.delete(key(projectId, mrIid));
}

/** Số review đang chạy — cho /stats observability. */
export function inflightCount(): number {
  return inflight.size;
}

/** Test-only: clear toàn bộ Map. Dùng trong `afterEach` để tránh leak state. */
export function _resetForTest(): void {
  for (const entry of inflight.values()) {
    entry.abortController.abort();
  }
  inflight.clear();
}
