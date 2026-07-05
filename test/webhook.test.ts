/**
 * Unit tests for webhook filtering + tool guardrails.
 * Run: `bun test`
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveCiWaitTimeoutMs, shouldReview, verifyToken } from "../src/webhook.ts";
import { aggregatePipelineStatus, mrContextFromWebhook, resolvePipelineProjectId, type MrPipelineEntry } from "../src/gitlab.ts";
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
import type { MergeRequestWebhook, PipelineStatus, PipelineWebhook } from "../src/types.ts";

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

// ─── BUG 4 doc: block=true phải unapprove trước khi review lại ─
// Note: performReview gọi nhiều side-effect (clone, fetch, AI) nên khó unit test
// end-to-end. Test dưới đây verify CONFIG TRIGGER — `block.enabled=true` là điều
// kiện tiên quyết để unapprove chạy. Logic unapprove đã idempotent (test ở gitlab).

describe("BUG 4: block.enabled triggers unapprove on re-review", () => {
  test("block.enabled=true là gate cho unapprove logic", () => {
    // Verify config field tồn tại + default false (backward compat).
    expect(DEFAULT_CONFIG.block.enabled).toBe(false);

    // Khi project set true → performReview sẽ gọi unapproveMr ở entry point.
    const cfgBlockOn = mergeConfig({ block: { enabled: true } });
    expect(cfgBlockOn.block.enabled).toBe(true);

    // Default → không unapprove (project không dùng gate).
    const cfgBlockOff = mergeConfig({ block: { enabled: false } });
    expect(cfgBlockOff.block.enabled).toBe(false);
  });

  test("block.enabled=true kết hợp được với ci.require=true", () => {
    // Combo này rất phổ biến: project muốn (1) đợi CI pass + (2) gate merge.
    // Khi push mới + cả 2 enabled:
    //   1. performReview unapprove ngay (block=true) → MR blocked
    //   2. checkCiAndWait → enqueue đợi CI (10+ phút) → MR vẫn blocked
    //   3. CI pass → review → re-approve nếu PASS
    const cfg = mergeConfig({
      block: { enabled: true },
      ci: { require: true },
    });
    expect(cfg.block.enabled).toBe(true);
    expect(cfg.ci.require).toBe(true);
  });
});

// ─── BUG 5 regression: SHA asymmetry → CI wait mode stuck "running" ──
// Root cause: `mrContextFromWebhook` không fallback SHA khi `source_branch_sha`
// undefined. Trong khi `ciwait.ts:enqueuePendingReview` + `inflight.ts:registerReview`
// đều fallback `mr.source_branch_sha ?? mr.last_commit?.id`.
//
// Asymmetry → `getMrPipelineStatus` filter theo SHA undefined → lấy TẤT CẢ pipelines
// của MR (kể cả zombie cũ) → aggregate return "running" → bot enqueue đợi → stuck.
//
// Trigger condition: webhook không gửi source_branch_sha (open/reopen event,
// hoặc nhiều GitLab self-managed versions chỉ có last_commit).

describe("BUG 5 regression: mrContextFromWebhook SHA fallback", () => {
  test("source_branch_sha present → dùng trực tiếp (no regression)", () => {
    const w = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        source_branch_sha: "abc123",
      },
    });
    const ctx = mrContextFromWebhook(w);
    expect(ctx.sourceSha).toBe("abc123");
  });

  test("source_branch_sha undefined + last_commit.id present → fallback đúng", () => {
    // Edge case phổ biến: open/reopen event chỉ có last_commit.
    const w = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
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
    const ctx = mrContextFromWebhook(w);
    expect(ctx.sourceSha).toBe("fromlastcommit");
  });

  test("cả 2 undefined → sourceSha undefined (không crash)", () => {
    const w = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        source_branch_sha: undefined,
        last_commit: undefined,
      },
    });
    const ctx = mrContextFromWebhook(w);
    expect(ctx.sourceSha).toBeUndefined();
  });

  test("CONSISTENCY: cùng payload → mrContextFromWebhook + enqueuePendingReview dùng cùng SHA", () => {
    // Property test: 3 chỗ resolve SHA phải agree. Nếu lệch nhau → pipeline webhook
    // consume được entry nhưng getMrPipelineStatus filter sai (BUG 5 gốc).
    const w = makeWebhook({
      object_attributes: {
        ...makeWebhook().object_attributes,
        iid: 99,
        source_branch_sha: undefined,
        last_commit: {
          id: "sharedsha",
          message: "",
          timestamp: "",
          url: "",
          author: { name: "", email: "" },
        },
      },
    });

    // mrContextFromWebhook resolve
    const ctx = mrContextFromWebhook(w);
    expect(ctx.sourceSha).toBe("sharedsha");

    // enqueuePendingReview resolve — phải cùng SHA
    resetCiwait();
    enqueuePendingReview(w, 60_000, () => {});
    const entry = consumePendingReview(100, "sharedsha");
    expect(entry).toBeDefined();
    expect(ctx.sourceSha).toBe("sharedsha"); // cùng value
    resetCiwait();
  });
});

describe("BUG 5 regression: aggregatePipelineStatus filter đúng khi SHA resolve", () => {
  function pipe(status: PipelineStatus, sha: string): MrPipelineEntry {
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

  test("trước fix: SHA undefined → lấy tất cả → có zombie running → stuck 'running'", () => {
    // Reproduce BUG 5 gốc: pipeline commit cũ kẹt running + pipeline mới success.
    // Trước fix: filter với SHA undefined → relevant = all → aggregate "running".
    // Sau fix: SHA resolve được → filter chỉ pipeline mới → aggregate "success".
    const oldSha = "oldcommit123";
    const newSha = "newcommit456";
    const pipelinesFromGitlab = [
      pipe("success", newSha), // pipeline mới — CI pass
      pipe("running", oldSha), // pipeline cũ — zombie kẹt running
    ];

    // Giả lập filter của getMrPipelineStatus với SHA được resolve đúng (post-fix).
    // mrContextFromWebhook bây giờ fallback last_commit.id → có SHA.
    const resolvedSha = newSha; // post-fix: được resolve từ last_commit.id
    const relevant = pipelinesFromGitlab.filter((p) => p.sha === resolvedSha);

    // Post-fix: chỉ filter được pipeline mới → aggregate = success (CI pass, review được).
    const result = aggregatePipelineStatus(relevant);
    expect(result.hasPipeline).toBe(true);
    if (result.hasPipeline) {
      expect(result.status).toBe("success");
      expect(result.sha).toBe(newSha);
    }
  });

  test("post-fix: filter đúng → multi-pipeline cùng SHA vẫn aggregate đúng", () => {
    // Multi-pipeline workflow (branch + MR pipeline) cho cùng SHA — phải aggregate cả 2.
    const sha = "sharedheadsha";
    const pipelinesFromGitlab = [
      pipe("success", sha),
      pipe("success", sha),
    ];

    const resolvedSha = sha;
    const relevant = pipelinesFromGitlab.filter((p) => p.sha === resolvedSha);

    const result = aggregatePipelineStatus(relevant);
    expect(result.hasPipeline).toBe(true);
    if (result.hasPipeline) {
      expect(result.status).toBe("success");
    }
  });
});

// ─── BUG 7 regression: pipeline webhook không resolve được projectId ──
// Root cause: code cũ đọc `attrs?.project_id` từ `object_attributes`, nhưng
// GitLab pipeline webhook payload thật đặt project_id ở **top-level** `project.id`
// (xem docs: https://docs.gitlab.com/development/webhooks/).
//
// Trước fix: `attrs?.project_id` → luôn undefined → bot skip mọi pipeline
// webhook → CI wait mode stuck đến timeout 10 phút.
//
// Log signature trước fix:
//   [webhook] pipeline skip — missing project_id or sha (projectId=undefined, sha=c10bf102...)

describe("BUG 7 regression: resolvePipelineProjectId đọc đúng field", () => {
  /** Fixture rút gọn từ payload pipeline webhook THẬT của GitLab (lttech-ga/live-stream !8). */
  function makePipelineWebhook(
    overrides: Partial<PipelineWebhook> = {},
  ): PipelineWebhook {
    return {
      object_kind: "pipeline",
      event_type: "pipeline",
      user: { id: 26883296, name: "naicoi", username: "naicoi92" },
      project: {
        id: 84085557,
        name: "Live Stream",
        path: "live-stream",
        path_with_namespace: "lttech-ga/live-stream",
        namespace: "lttech-ga",
        web_url: "https://gitlab.com/lttech-ga/live-stream",
        git_http_url: "https://gitlab.com/lttech-ga/live-stream.git",
        git_ssh_url: "git@gitlab.com:lttech-ga/live-stream.git",
        default_branch: "main",
        visibility_level: 0,
      },
      commit: {
        id: "c10bf102c1f7136d0a04838c16e73aab356637a0",
        message: "T-11: StreamState Display/FromStr",
        timestamp: "2026-07-05T18:19:50+07:00",
      },
      object_attributes: {
        id: 2652759704,
        ref: "feat/T-11-state-machine",
        status: "success",
        sha: "c10bf102c1f7136d0a04838c16e73aab356637a0",
        source: "merge_request_event",
      },
      merge_request: {
        id: 503447125,
        iid: 8,
        source_branch: "feat/T-11-state-machine",
        target_branch: "main",
        source_project_id: 84085557,
        target_project_id: 84085557,
        state: "opened",
      },
      builds: [],
      ...overrides,
    };
  }

  test("payload chuẩn GitLab (project.id top-level) → resolve đúng", () => {
    // Reproduce payload thật user paste — KHÔNG có object_attributes.project_id.
    // Code cũ đọc field đó → undefined → skip. Code mới phải resolve từ project.id.
    const pipeline = makePipelineWebhook();
    expect(resolvePipelineProjectId(pipeline)).toBe(84085557);
  });

  test("fallback merge_request.target_project_id khi thiếu project block", () => {
    // Edge case: 1 số payload legacy/self-managed không có top-level project.
    // Fallback về merge_request.target_project_id (đây là project đang review).
    const pipeline = makePipelineWebhook({ project: undefined });
    expect(resolvePipelineProjectId(pipeline)).toBe(84085557);
  });

  test("returns undefined khi cả project + merge_request đều thiếu → bot skip", () => {
    // Malformed payload (không nên xảy ra nhưng defensive) → undefined → skip.
    const pipeline = makePipelineWebhook({
      project: undefined,
      merge_request: undefined,
    });
    expect(resolvePipelineProjectId(pipeline)).toBeUndefined();
  });

  test("KEY MATCH: resolvePipelineProjectId khớp key với enqueuePendingReview", () => {
    // Integration property test:
    // - MR webhook đến → enqueuePendingReview key = `${target_project_id}:${sha}`
    // - Pipeline webhook đến → consumePendingReview(projectId, sha)
    // - 2 phải MATCH nhau thì entry mới được consume → trigger review.
    //
    // Trước fix BUG 7: pipeline webhook gọi consumePendingReview(undefined, sha)
    // → không match → CI wait stuck.
    const mrWebhook = makeWebhook({
      project: {
        id: 84085557,
        name: "Live Stream",
        path: "live-stream",
        path_with_namespace: "lttech-ga/live-stream",
        namespace: "lttech-ga",
        web_url: "https://gitlab.com/lttech-ga/live-stream",
        git_http_url: "https://gitlab.com/lttech-ga/live-stream.git",
        git_ssh_url: "git@gitlab.com:lttech-ga/live-stream.git",
        default_branch: "main",
        visibility_level: 0,
      },
      object_attributes: {
        ...makeWebhook().object_attributes,
        iid: 8,
        target_project_id: 84085557,
        source_branch_sha: "c10bf102c1f7136d0a04838c16e73aab356637a0",
      },
    });
    const pipelineWebhook = makePipelineWebhook();

    // MR webhook side
    resetCiwait();
    enqueuePendingReview(mrWebhook, 60_000, () => {});
    expect(pendingCount()).toBe(1);

    // Pipeline webhook side — phải resolve cùng projectId để consume được entry
    const resolvedProjectId = resolvePipelineProjectId(pipelineWebhook);
    expect(resolvedProjectId).toBe(84085557);

    const entry = consumePendingReview(
      resolvedProjectId ?? -1,
      pipelineWebhook.object_attributes.sha,
    );
    expect(entry).toBeDefined();
    expect(entry?.payload.object_attributes.iid).toBe(8);
    expect(pendingCount()).toBe(0); // entry đã consume
    resetCiwait();
  });
});
