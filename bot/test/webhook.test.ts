/**
 * Unit tests for webhook filtering + tool guardrails.
 * Run: `bun test`
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { shouldReview, verifyToken } from "../src/webhook.ts";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { createInitialToolState } from "../src/tools/index.ts";
import type { MergeRequestWebhook } from "../src/types.ts";

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

  test("skips approved action", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, action: "approved" },
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

  test("skips update without new commit", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, action: "update" },
      changes: { last_commit: { previous: null, current: null } },
    });
    expect(shouldReview(w, DEFAULT_CONFIG).review).toBe(false);
  });

  test("accepts update WITH new commit", () => {
    const w = makeWebhook({
      object_attributes: { ...makeWebhook().object_attributes, action: "update" },
      changes: {
        last_commit: {
          previous: { id: "old", message: "old", timestamp: "", url: "", author: { name: "", email: "" } },
          current: { id: "new", message: "new", timestamp: "", url: "", author: { name: "", email: "" } },
        },
      },
    });
    expect(shouldReview(w, DEFAULT_CONFIG)).toEqual({ review: true });
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
