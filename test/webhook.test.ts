/**
 * Unit tests for webhook filtering + tool guardrails.
 * Run: `bun test`
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveCiWaitTimeoutMs, shouldReview, verifyToken } from "../src/webhook.ts";
import { aggregatePipelineStatus, type MrPipelineEntry } from "../src/gitlab.ts";
import { DEFAULT_CONFIG, mergeConfig, type ProjectConfig } from "../src/config.ts";
import {
  consumePendingReview,
  enqueuePendingReview,
  pendingCount,
  _resetForTest as resetCiwait,
} from "../src/ciwait.ts";
import {
  abortReview,
  completeReview,
  inflightCount,
  registerReview,
  _resetForTest as resetInflight,
} from "../src/inflight.ts";
import { createInitialToolState } from "../src/tools/index.ts";
import type { MergeRequestWebhook, PipelineStatus } from "../src/types.ts";

function makeWebhook(overrides: Partial<MergeRequestWebhook> = {}): MergeRequestWebhook {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: { id: 1, name: "Test", username: "test" },
    project: {
      id: 100,
      name: "demo",
      path: "demo",
      path_with_namespace: "acme/demo",
      namespace: "acme",
      web_url: "https://gitlab.com/acme/demo",
      git_http_url: "https://gitlab.com/acme/demo.git",
      git_ssh_url: "git@gitlab.com:acme/demo.git",
      default_branch: "main",
      visibility_level: 0,
    },
    object_attributes: {
      iid: 42,
      title: "feat: add login",
      state: "opened",
      action: "open",
      draft: false,
      source_branch: "feat/login",
      target_branch: "main",
      source_project_id: 100,
      target_project_id: 100,
      url: "https://gitlab.com/acme/demo/-/merge_requests/42",
      source_branch_sha: "abc123",
      target_branch_sha: "def456",
    },
    labels: [],
    changes: {},
    ...overrides,
  };
}

describe("verifyToken", () => {
  const originalSecret = process.env.WEBHOOK_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  test("returns false when WEBHOOK_SECRET unset in production", () => {
    delete process.env.WEBHOOK_SECRET;
    expect(verifyToken("anything")).toBe(false);
  });

  test("returns true when token matches", () => {
    process.env.WEBHOOK_SECRET = "my-secret";
    expect(verifyToken("my-secret")).toBe(true);
  });

  test("returns false when token mismatch", () => {
    process.env.WEBHOOK_SECRET = "my-secret";
    expect(verifyToken("wrong")).toBe(false);
  });

  test("returns false when header missing", () => {
    process.env.WEBHOOK_SECRET = "my-secret";
    expect(verifyToken(null)).toBe(false);
  });

  test("returns false when lengths differ", () => {
    process.env.WEBHOOK_SECRET = "my-secret";
    expect(verifyToken("my-secret-but-longer")).toBe(false);
  });

  test("dev mode accepts any token when secret unset", () => {
    delete process.env.WEBHOOK_SECRET;
    process.env.NODE_ENV = "development";
    expect(verifyToken("anything")).toBe(true);
  });

  afterEach(() => {
    if (originalSecret !== undefined) process.env.WEBHOOK_SECRET = originalSecret;
    else delete process.env.WEBHOOK_SECRET;
    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  });
});

describe("shouldReview", () => {
  test("accepts open action", () => {
    const w = makeWebhook();
    expect(shouldReview(w, DEFAULT_CONFIG)).toEqual({ review: true });
  });

  test("skips close action", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, action: "close" },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("skips draft MR", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, draft: true },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("skips work_in_progress legacy flag", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, work_in_progress: true },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("skips title with WIP", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, title: "WIP: not ready" },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("skips title with 'do not review'", () => {
    const w = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        title: "feat: x (do not review)",
      },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("skips branch wip/*", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, source_branch: "wip/feat-x" },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("skips branch scratch/*", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, source_branch: "scratch/test" },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("skips update when MR has no commits (title/description edit only)", () => {
    // Bug 2 regression: update event với MR chưa có commit nào (vd mới edit description)
    const w = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        action: "update",
        last_commit: undefined,  // MR chưa có commit
      },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
    expect(shouldReview(w, DEFAULT_CONFIG).reason).toBe("update-without-commit");
  });

  test("accepts update when MR has commits (regardless of changes.last_commit)", () => {
    // Bug 2 regression: GitLab không gửi changes.last_commit.current nhưng MR có commit
    // → phải vẫn review được
    const w = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        action: "update",
        last_commit: { id: "abc123", message: "feat: x", timestamp: "", url: "", author: { name: "", email: "" } },
      },
      changes: {},  // GitLab gửi rỗng (bug condition)
    });
    expect(shouldReview(w, DEFAULT_CONFIG)).toEqual({ review: true });
  });

  test("Bug 1 regression: accepts reopen action", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, action: "reopen" },
    });
    expect(shouldReview(w, DEFAULT_CONFIG)).toEqual({ review: true });
  });

  test("skips approved action (not code review trigger)", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, action: "approved" },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("skips mark_as_draft action", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, action: "mark_as_draft" },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });
});

describe("mergeConfig", () => {
  test("returns defaults when input empty", () => {
    const cfg = mergeConfig(null);
    expect(cfg.review.language).toBe("vi");
    expect(cfg.scope.enabled).toBe(false);
    expect(cfg.block.enabled).toBe(false);
  });

  test("overrides language", () => {
    const cfg = mergeConfig({ review: { language: "en" } });
    expect(cfg.review.language).toBe("en");
  });

  test("block.enabled can be overridden", () => {
    const cfg = mergeConfig({ block: { enabled: true } });
    expect(cfg.block.enabled).toBe(true);
  });

  test("ignores unknown fields", () => {
    const cfg = mergeConfig({ unknownField: true, review: { language: "en", bogus: 1 } });
    expect(cfg.review.language).toBe("en");
  });
});

describe("createInitialToolState", () => {
  test("starts with summaryPosted=false", () => {
    const s = createInitialToolState();
    expect(s.summaryPosted).toBe(false);
    expect(s.criticalCount).toBe(0);
    expect(s.approved).toBe(false);
    expect(s.changesRequested).toBe(false);
    expect(s.toolCallCount).toBe(0);
    expect(s.inlineCommentsPosted).toBe(0);
  });
});

// ─── CI wait mode regression tests ───────────────────────────
// Mỗi fix bug / feature mới PHẢI có test case regression (xem AGENTS.md).

describe("mergeConfig — ci.* fields", () => {
  test("default ci.require=false", () => {
    expect(DEFAULT_CONFIG.ci.require).toBe(false);
    expect(DEFAULT_CONFIG.ci.waitTimeoutMs).toBeUndefined();
  });

  test("reads ci.require=true", () => {
    const cfg = mergeConfig({ ci: { require: true } });
    expect(cfg.ci.require).toBe(true);
  });

  test("reads ci.waitTimeoutMs (positive integer)", () => {
    const cfg = mergeConfig({ ci: { waitTimeoutMs: 1_800_000 } });
    expect(cfg.ci.waitTimeoutMs).toBe(1_800_000);
  });

  test("rejects non-number waitTimeoutMs", () => {
    const cfg = mergeConfig({ ci: { waitTimeoutMs: "abc" } });
    expect(cfg.ci.waitTimeoutMs).toBeUndefined();
  });

  test("rejects negative waitTimeoutMs", () => {
    const cfg = mergeConfig({ ci: { waitTimeoutMs: -100 } });
    expect(cfg.ci.waitTimeoutMs).toBeUndefined();
  });

  test("rejects NaN waitTimeoutMs", () => {
    const cfg = mergeConfig({ ci: { waitTimeoutMs: NaN } });
    expect(cfg.ci.waitTimeoutMs).toBeUndefined();
  });

  test("floors float waitTimeoutMs", () => {
    const cfg = mergeConfig({ ci: { waitTimeoutMs: 600000.9 } });
    expect(cfg.ci.waitTimeoutMs).toBe(600000);
  });

  test("ignores unknown ci.* fields", () => {
    const cfg = mergeConfig({ ci: { require: true, bogus: 1 } });
    expect(cfg.ci.require).toBe(true);
    expect((cfg.ci as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe("resolveCiWaitTimeoutMs — priority chain", () => {
  const originalEnv = process.env.CI_WAIT_TIMEOUT_MS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CI_WAIT_TIMEOUT_MS;
    else process.env.CI_WAIT_TIMEOUT_MS = originalEnv;
  });

  test("per-project waitTimeoutMs wins over env", () => {
    process.env.CI_WAIT_TIMEOUT_MS = "300000";
    const cfg: ProjectConfig = structuredClone(DEFAULT_CONFIG);
    cfg.ci.waitTimeoutMs = 1_800_000;
    expect(resolveCiWaitTimeoutMs(cfg)).toBe(1_800_000);
  });

  test("env wins when per-project unset", () => {
    process.env.CI_WAIT_TIMEOUT_MS = "300000";
    const cfg: ProjectConfig = structuredClone(DEFAULT_CONFIG);
    expect(resolveCiWaitTimeoutMs(cfg)).toBe(300000);
  });

  test("hardcoded fallback (600000) when both unset", () => {
    delete process.env.CI_WAIT_TIMEOUT_MS;
    const cfg: ProjectConfig = structuredClone(DEFAULT_CONFIG);
    expect(resolveCiWaitTimeoutMs(cfg)).toBe(600_000);
  });

  test("rejects non-numeric env", () => {
    process.env.CI_WAIT_TIMEOUT_MS = "not-a-number";
    const cfg: ProjectConfig = structuredClone(DEFAULT_CONFIG);
    expect(resolveCiWaitTimeoutMs(cfg)).toBe(600_000);
  });

  test("rejects negative env", () => {
    process.env.CI_WAIT_TIMEOUT_MS = "-5";
    const cfg: ProjectConfig = structuredClone(DEFAULT_CONFIG);
    expect(resolveCiWaitTimeoutMs(cfg)).toBe(600_000);
  });
});

describe("ciwait — pending Map lifecycle", () => {
  beforeEach(() => {
    resetCiwait();
  });

  afterEach(() => {
    resetCiwait();
  });

  function makeMrWebhook(overrides: Partial<MergeRequestWebhook> = {}): MergeRequestWebhook {
    return {
      ...makeWebhook(),
      object_attributes: {
        ...makeWebhook().object_attributes,
        target_project_id: 100,
        source_branch_sha: "abc123",
      },
      ...overrides,
    };
  }

  test("enqueue + consume roundtrip", () => {
    const payload = makeMrWebhook();
    let timeoutCalled = false;
    enqueuePendingReview(payload, 60_000, () => {
      timeoutCalled = true;
    });

    expect(pendingCount()).toBe(1);

    const entry = consumePendingReview(100, "abc123");
    expect(entry).toBeDefined();
    expect(entry?.payload).toBe(payload);

    // After consume, Map empty + timeout canceled (won't fire).
    expect(pendingCount()).toBe(0);
    expect(timeoutCalled).toBe(false);
  });

  test("consume returns undefined when no pending", () => {
    expect(consumePendingReview(999, "nope")).toBeUndefined();
  });

  test("consume returns undefined for wrong SHA", () => {
    const payload = makeMrWebhook();
    enqueuePendingReview(payload, 60_000, () => {});
    expect(consumePendingReview(100, "different-sha")).toBeUndefined();
    // Entry vẫn còn — không match SHA.
    expect(pendingCount()).toBe(1);
  });

  test("re-push overrides existing entry (clears old timeout)", () => {
    const payload1 = makeMrWebhook({
      object_attributes: {
        ...makeMrWebhook().object_attributes,
        iid: 1,
      },
    });
    const payload2 = makeMrWebhook({
      object_attributes: {
        ...makeMrWebhook().object_attributes,
        iid: 2,
      },
    });

    let firstTimeoutFired = false;
    enqueuePendingReview(payload1, 60_000, () => {
      firstTimeoutFired = true;
    });
    enqueuePendingReview(payload2, 60_000, () => {}); // override cùng key

    expect(pendingCount()).toBe(1); // vẫn 1 entry (override)
    const entry = consumePendingReview(100, "abc123");
    expect(entry?.payload.object_attributes.iid).toBe(2); // entry mới thắng
    expect(firstTimeoutFired).toBe(false); // timeout cũ bị clear, không fire
  });

  test("BUG 1 regression: re-push với SHA mới clear entry cũ theo MR IID", () => {
    // Scenario: dev push SHA=a → bot enqueue entry[100:a] cho MR !1.
    //          dev push SHA=b (fix-up) → bot enqueue entry[100:b] cho cùng MR !1.
    //          Pipeline webhook cho SHA=a đến → KHÔNG được trigger review (stale).
    const payloadShaA = makeMrWebhook({
      object_attributes: {
        ...makeMrWebhook().object_attributes,
        iid: 1,
        source_branch_sha: "shaA",
      },
    });
    const payloadShaB = makeMrWebhook({
      object_attributes: {
        ...makeMrWebhook().object_attributes,
        iid: 1, // cùng MR IID
        source_branch_sha: "shaB", // SHA mới
      },
    });

    enqueuePendingReview(payloadShaA, 60_000, () => {});
    expect(pendingCount()).toBe(1);
    expect(consumePendingReview(100, "shaA")).toBeDefined(); // entry[100:shaA] còn

    // Re-enqueue SHA=B → entry[100:shaA] phải bị clear.
    enqueuePendingReview(payloadShaB, 60_000, () => {});
    expect(pendingCount()).toBe(1); // chỉ còn entry[100:shaB]

    // Pipeline webhook cho SHA=A (cũ) đến → không tìm thấy entry → undefined.
    expect(consumePendingReview(100, "shaA")).toBeUndefined();

    // Pipeline webhook cho SHA=B (mới) đến → trigger review đúng.
    const entry = consumePendingReview(100, "shaB");
    expect(entry).toBeDefined();
    expect(entry?.payload.object_attributes.source_branch_sha).toBe("shaB");
  });

  test("timeout fires + removes entry", async () => {
    const payload = makeMrWebhook();
    let timeoutFired = false;
    enqueuePendingReview(payload, 50, () => {
      timeoutFired = true;
    });
    expect(pendingCount()).toBe(1);

    // Đợi timeout fire (50ms + buffer).
    await new Promise((r) => setTimeout(r, 100));

    expect(timeoutFired).toBe(true);
    expect(pendingCount()).toBe(0);
  });

  test("enqueue without SHA — silently skipped (no entry)", () => {
    const payload = makeMrWebhook({
      object_attributes: {
        ...makeMrWebhook().object_attributes,
        source_branch_sha: undefined,
        last_commit: undefined,
      },
    });
    enqueuePendingReview(payload, 60_000, () => {});
    expect(pendingCount()).toBe(0);
  });

  test("falls back to last_commit.id when source_branch_sha missing", () => {
    const payload = makeMrWebhook({
      object_attributes: {
        ...makeMrWebhook().object_attributes,
        source_branch_sha: undefined,
        last_commit: {
          id: "fromlastcommit",
          message: "",
          timestamp: "",
          url: "",
          author: { name: "", email: "" },
        },
      },
    });
    enqueuePendingReview(payload, 60_000, () => {});
    expect(pendingCount()).toBe(1);
    expect(consumePendingReview(100, "fromlastcommit")).toBeDefined();
  });
});

describe("DEFAULT_CONFIG.ci is well-formed", () => {
  test("ci field present in default", () => {
    expect(DEFAULT_CONFIG.ci).toBeDefined();
    expect(DEFAULT_CONFIG.ci.require).toBe(false);
  });

  test("shouldReview không bị ảnh hưởng bởi ci.require", () => {
    // shouldReview là sync filter — không check CI (CI check là async, trong performReview).
    const cfgOff = mergeConfig({ ci: { require: false } });
    const cfgOn = mergeConfig({ ci: { require: true } });
    const w = makeWebhook();
    expect(shouldReview(w, cfgOff)).toEqual({ review: true });
    expect(shouldReview(w, cfgOn)).toEqual({ review: true });
  });
});

// ─── aggregatePipelineStatus — BUG 2 regression ──────────────
// Multi-pipeline cùng SHA: bot phải aggregate TẤT CẢ, không chỉ pipeline[0].

describe("aggregatePipelineStatus — multi-pipeline aggregate (BUG 2)", () => {
  function pipe(status: PipelineStatus, sha = "abc"): MrPipelineEntry {
    return {
      id: Math.floor(Math.random() * 1_000_000),
      sha,
      ref: "feat/test",
      status,
      created_at: "2026-07-05T00:00:00Z",
      updated_at: "2026-07-05T00:00:00Z",
      web_url: "https://gitlab.com/test/pipelines/-/1",
    };
  }

  test("empty array → hasPipeline: false", () => {
    expect(aggregatePipelineStatus([])).toEqual({ hasPipeline: false });
  });

  test("single success → success", () => {
    expect(aggregatePipelineStatus([pipe("success")])).toEqual({
      hasPipeline: true,
      status: "success",
      sha: "abc",
    });
  });

  test("single running → running", () => {
    expect(aggregatePipelineStatus([pipe("running")])).toEqual({
      hasPipeline: true,
      status: "running",
      sha: "abc",
    });
  });

  test("single failed → failed", () => {
    expect(aggregatePipelineStatus([pipe("failed")])).toEqual({
      hasPipeline: true,
      status: "failed",
      sha: "abc",
    });
  });

  test("BUG 2a: branch success + MR running → running (đợi tất cả)", () => {
    // Workflow GitLab chuẩn: branch pipeline (source=push) + MR pipeline (source=merge_request_event)
    // Nếu branch xong trước MR → tổng phải running.
    const pipelines = [
      pipe("success", "abc"), // branch pipeline done
      pipe("running", "abc"), // MR pipeline still going
    ];
    expect(aggregatePipelineStatus(pipelines)).toEqual({
      hasPipeline: true,
      status: "running",
      sha: "abc",
    });
  });

  test("BUG 2b: branch failed + MR success → failed (KHÔNG chỉ check pipeline[0])", () => {
    // Pipelines list từ GitLab: MR pipeline trước (mới hơn), branch pipeline sau.
    // Nếu bot cũ chỉ check [0] → return success → review nhưng CI tổng đã fail.
    const pipelines = [
      pipe("success", "abc"), // MR pipeline [0] — bot cũ chỉ check cái này
      pipe("failed", "abc"),  // branch pipeline [1] — bot cũ miss
    ];
    const result = aggregatePipelineStatus(pipelines);
    expect(result.hasPipeline).toBe(true);
    if (result.hasPipeline) {
      expect(result.status).toBe("failed"); // phải catch failure của branch pipeline
    }
  });

  test("BUG 2c: cả 2 success → success", () => {
    const pipelines = [
      pipe("success", "abc"),
      pipe("success", "abc"),
    ];
    expect(aggregatePipelineStatus(pipelines)).toEqual({
      hasPipeline: true,
      status: "success",
      sha: "abc",
    });
  });

  test("running + failed → running (chưa xong thì không kết luận fail)", () => {
    // 1 pipeline fail, 1 pipeline vẫn chạy → bot phải đợi pipeline đang chạy xong.
    const pipelines = [
      pipe("failed", "abc"),
      pipe("running", "abc"),
    ];
    const result = aggregatePipelineStatus(pipelines);
    expect(result.hasPipeline).toBe(true);
    if (result.hasPipeline) {
      expect(result.status).toBe("running");
    }
  });

  test("manual pipeline chỉ không block success", () => {
    // Workflow rule: pipeline có `when: manual` → status=manual, chờ user trigger.
    // Bot coi manual như "không block" — nếu các pipeline khác success → tổng success.
    const pipelines = [
      pipe("success", "abc"),
      pipe("manual", "abc"),
    ];
    expect(aggregatePipelineStatus(pipelines)).toEqual({
      hasPipeline: true,
      status: "success",
      sha: "abc",
    });
  });

  test("canceled pipeline → failure", () => {
    const pipelines = [pipe("canceled", "abc")];
    const result = aggregatePipelineStatus(pipelines);
    expect(result.hasPipeline).toBe(true);
    if (result.hasPipeline) {
      expect(result.status).toBe("canceled");
    }
  });
});

// ─── In-flight review coordinator — BUG 3 regression ─────────
// Review đang chạy + push mới → cancel review cũ qua AbortSignal.

describe("inflight coordinator — cancel review cũ khi push mới (BUG 3)", () => {
  beforeEach(() => {
    resetInflight();
  });

  afterEach(() => {
    resetInflight();
  });

  test("register returns entry with non-aborted signal", () => {
    const payload = makeWebhook();
    const entry = registerReview(payload);
    expect(entry.mrIid).toBe(42);
    expect(entry.projectId).toBe(100);
    expect(entry.abortController.signal.aborted).toBe(false);
    expect(inflightCount()).toBe(1);
  });

  test("BUG 3: register review mới abort review cũ cùng MR IID", () => {
    const payload1 = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        source_branch_sha: "shaA",
      },
    });
    const payload2 = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        source_branch_sha: "shaB", // SHA mới
      },
    });

    const entry1 = registerReview(payload1);
    expect(entry1.abortController.signal.aborted).toBe(false);

    // Push mới → register entry2 → entry1 phải bị abort.
    const entry2 = registerReview(payload2);
    expect(entry1.abortController.signal.aborted).toBe(true); // ← fix BUG 3
    expect(entry2.abortController.signal.aborted).toBe(false);
    expect(inflightCount()).toBe(1); // vẫn 1 entry (override)
  });

  test("2 MR khác nhau KHÔNG abort lẫn nhau", () => {
    const payload1 = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, iid: 1 },
    });
    const payload2 = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, iid: 2 }, // khác MR IID
    });

    const entry1 = registerReview(payload1);
    const entry2 = registerReview(payload2);

    expect(entry1.abortController.signal.aborted).toBe(false); // không bị abort
    expect(entry2.abortController.signal.aborted).toBe(false);
    expect(inflightCount()).toBe(2); // 2 entry song song
  });

  test("completeReview clears entry → review kế tiếp không abort nhầm", () => {
    const payload1 = makeWebhook();
    const payload2 = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        source_branch_sha: "shaB",
      },
    });

    const entry1 = registerReview(payload1);
    completeReview(100, 42); // review 1 xong
    expect(inflightCount()).toBe(0);

    // Register review 2 → không có entry cũ → không abort gì.
    registerReview(payload2);
    expect(entry1.abortController.signal.aborted).toBe(false); // đã complete, không touch
    expect(inflightCount()).toBe(1);
  });

  test("abortReview explicit — idempotent khi không có entry", () => {
    expect(abortReview(999, 999)).toBe(false); // không có entry → false
  });

  test("abortReview explicit — abort + clear entry", () => {
    const payload = makeWebhook();
    const entry = registerReview(payload);
    const aborted = abortReview(100, 42);
    expect(aborted).toBe(true);
    expect(entry.abortController.signal.aborted).toBe(true);
    expect(inflightCount()).toBe(0);
  });

  test("re-push cùng SHA vẫn abort entry cũ (idempotent an toàn)", () => {
    // Webhook queue có thể deliver duplicate — register lại cùng SHA vẫn abort entry cũ,
    // entry mới được set. An toàn vì SDK session của entry cũ sẽ reject.
    const payload = makeWebhook();
    const entry1 = registerReview(payload);
    const entry2 = registerReview(payload); // cùng SHA, cùng IID
    expect(entry1.abortController.signal.aborted).toBe(true);
    expect(entry2.abortController.signal.aborted).toBe(false);
    expect(inflightCount()).toBe(1);
  });

  test("completeReview idempotent — clear entry không tồn tại không lỗi", () => {
    expect(() => completeReview(999, 999)).not.toThrow();
  });
});
