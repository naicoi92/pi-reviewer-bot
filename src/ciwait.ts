/**
 * CI wait coordinator — bridge giữa MR webhook và Pipeline webhook.
 *
 * Khi `cfg.ci.require = true`, bot KHÔNG review ngay khi nhận MR webhook
 * nếu CI đang chạy. Thay vào đó:
 *
 *   1. MR webhook đến + CI running → `enqueuePendingReview()` lưu payload
 *      + set timeout GC. Bot post note "⏸ đợi CI" rồi return.
 *   2. Pipeline webhook `status=success` đến → `consumePendingReview()`
 *      lấy payload ra + clear timeout → gọi `performReview({ skipCiCheck: true })`.
 *   3. Nếu CI chạy quá lâu (>timeoutMs), timeout fire → caller decides
 *      (default: review anyway + log warning).
 *
 * State lưu in-memory (Map). Trade-off: mất khi bot restart → user push retry
 * (cùng pattern như bot error hiện tại — `webhook.ts:211` "Bot will retry on next push").
 *
 * Key là `${projectId}:${sha}` — match pipeline với MR chính xác tại commit
 * đang review. Robust với re-push: entry cũ bị override.
 */

import type { MergeRequestWebhook } from "./types.ts";

interface PendingReview {
  payload: MergeRequestWebhook;
  queuedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/**
 * Singleton Map — toàn bộ bot dùng chung 1 instance.
 * Key: `${projectId}:${sha}` — match pipeline với MR tại commit chính xác.
 */
const pendingReviews = new Map<string, PendingReview>();

/**
 * Secondary index: `${projectId}:${mrIid}` → SHA.
 *
 * Mục đích: clear entry cũ khi re-push. Khi dev push SHA=b lên MR đang chờ
 * với SHA=a, ta cần huỷ entry `projectId:a` để pipeline webhook cho SHA=a
 * (nếu đến) không trigger review cho commit cũ nữa.
 *
 * Không lưu entry trong map này — chỉ index SHA để lookup.
 */
const pendingByMrIid = new Map<string, string>();

/** Sinh key Map chính từ projectId + SHA. */
export function pendingKey(projectId: number, sha: string): string {
  return `${projectId}:${sha}`;
}

/** Sinh key secondary index từ projectId + mrIid. */
function mrKey(projectId: number, mrIid: number): string {
  return `${projectId}:${mrIid}`;
}

/**
 * Lưu review đang đợi CI. Nếu đã có entry cho cùng key (re-push), override:
 * clear timeout cũ, set entry mới với timeout mới.
 *
 * **Quan trọng (fix BUG 1)**: cũng clear entry cũ của cùng MR IID (khác SHA).
 * Scenario: dev push SHA=a → bot enqueue entry `100:a`. Dev push SHA=b (fix-up)
 * → bot enqueue entry `100:b`. Nếu không clear entry `100:a`, pipeline webhook
 * cho SHA=a (GitLab retry / queue chậm) sẽ trigger review cho commit cũ.
 */
export function enqueuePendingReview(
  payload: MergeRequestWebhook,
  timeoutMs: number,
  onTimeout: (payload: MergeRequestWebhook) => void,
): void {
  const mr = payload.object_attributes;
  const projectId = mr.target_project_id;
  // Ưu tiên source_branch_sha (head SHA của MR tại thời điểm webhook),
  // fallback last_commit.id (luôn present trên update event).
  const sha = mr.source_branch_sha ?? mr.last_commit?.id;
  if (!sha) {
    // Không có SHA → không thể match với pipeline → skip enqueue, caller fallback review anyway.
    return;
  }

  const key = pendingKey(projectId, sha);
  const mKey = mrKey(projectId, mr.iid);

  // Clear entry cũ của cùng MR IID (có thể khác SHA) — fix BUG 1.
  // Đây là fix quan trọng: re-push tạo entry mới SHA, nhưng entry cũ SHA
  // (cùng MR IID) phải bị huỷ để pipeline webhook cho SHA cũ không trigger.
  const previousSha = pendingByMrIid.get(mKey);
  if (previousSha && previousSha !== sha) {
    const oldKey = pendingKey(projectId, previousSha);
    const oldEntry = pendingReviews.get(oldKey);
    if (oldEntry) {
      clearTimeout(oldEntry.timeoutHandle);
      pendingReviews.delete(oldKey);
    }
  }

  // Override entry cùng SHA nếu có (vd MR webhook đến 2 lần).
  const existing = pendingReviews.get(key);
  if (existing) {
    clearTimeout(existing.timeoutHandle);
  }

  const entry: PendingReview = {
    payload,
    queuedAt: Date.now(),
    timeoutHandle: setTimeout(() => {
      // Self-remove nếu entry vẫn còn (consume có thể đã xoá trước).
      if (pendingReviews.get(key)?.payload === payload) {
        pendingReviews.delete(key);
        pendingByMrIid.delete(mKey);
        onTimeout(payload);
      }
    }, timeoutMs),
  };

  pendingReviews.set(key, entry);
  pendingByMrIid.set(mKey, sha);
}

/**
 * Lấy + xoá entry khi pipeline webhook báo `status=success`.
 * Returns `undefined` nếu không có entry nào match (idempotent — skip).
 *
 * Clear timeout để tránh leak — entry được consume nghĩa là CI đã pass,
 * không cần timeout GC nữa.
 */
export function consumePendingReview(
  projectId: number,
  sha: string,
): PendingReview | undefined {
  const key = pendingKey(projectId, sha);
  const entry = pendingReviews.get(key);
  if (!entry) return undefined;
  clearTimeout(entry.timeoutHandle);
  pendingReviews.delete(key);
  // Cleanup secondary index.
  const mKey = mrKey(projectId, entry.payload.object_attributes.iid);
  if (pendingByMrIid.get(mKey) === sha) {
    pendingByMrIid.delete(mKey);
  }
  return entry;
}

/** Số review đang đợi CI — cho /stats observability. */
export function pendingCount(): number {
  return pendingReviews.size;
}

/**
 * Test-only: clear toàn bộ Map + clear timeouts. Dùng trong `afterEach`
 * của unit tests để tránh leak state giữa test cases.
 */
export function _resetForTest(): void {
  for (const entry of pendingReviews.values()) {
    clearTimeout(entry.timeoutHandle);
  }
  pendingReviews.clear();
  pendingByMrIid.clear();
}
