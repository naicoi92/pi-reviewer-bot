/**
 * Hono app entrypoint.
 *
 * Routes:
 *   GET  /          → mini landing page (bot info + version)
 *   GET  /healthz   → Fly.io healthcheck
 *   POST /webhook   → GitLab webhook receiver
 */

import { Hono } from "hono";
import { consumePendingReview, pendingCount } from "./ciwait.ts";
import { inflightCount } from "./inflight.ts";
import { performReview, shouldReview, verifyToken } from "./webhook.ts";
import { globalSemaphore } from "./limiter.ts";
import { stats } from "./stats.ts";
import type { AnyGitLabWebhook, MergeRequestWebhook, PipelineWebhook } from "./types.ts";

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3000);
const VERSION = "0.1.0";

/** Landing page — bot info. */
app.get("/", (c) =>
  c.json({
    name: "pi-reviewer-bot",
    version: VERSION,
    description: "GitLab webhook bot — AI code review with Pi Coding Agent SDK + Z.ai GLM-5.2 (Mức 3 full tool)",
    endpoints: {
      "POST /webhook": "GitLab webhook receiver (Merge Request events)",
      "GET /healthz": "Health check",
      "GET /stats": "Per-project review stats",
      "GET /": "This info",
    },
    docs: "https://github.com/<owner>/pi-reviewer-bot/blob/main/docs/SETUP.md",
  }),
);

/** Health check for Fly.io + monitoring. */
app.get("/healthz", (c) =>
  c.json({
    ok: true,
    version: VERSION,
    uptime: process.uptime(),
    reviewsInFlight: globalSemaphore.current,
    reviewsActive: inflightCount(),
    ciWaitPending: pendingCount(),
  }),
);

/**
 * Multi-project observability endpoint.
 *
 * Returns per-project review stats: total, outcome distribution,
 * average duration, last review time. Useful for dashboards + ops.
 *
 * Public by default (no auth) — contains no secrets, only aggregate counts.
 * Set STATS_AUTH_TOKEN env to require Bearer auth on this endpoint.
 */
app.get("/stats", (c) => {
  if (process.env.STATS_AUTH_TOKEN) {
    const auth = c.req.header("authorization") ?? "";
    const expected = `Bearer ${process.env.STATS_AUTH_TOKEN}`;
    if (auth !== expected) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }
  const snapshot = stats.snapshot();
  return c.json({
    ...snapshot,
    concurrency: {
      active: globalSemaphore.current,
      max: Number(process.env.MAX_CONCURRENT_REVIEWS ?? 3),
    },
    reviewsActive: inflightCount(),
    ciWait: {
      pending: pendingCount(),
    },
  });
});

/** Webhook receiver. */
app.post("/webhook", async (c) => {
  // 1. Verify token
  const token = c.req.header("x-gitlab-token") ?? null;
  if (!verifyToken(token)) {
    return c.json({ error: "invalid or missing X-Gitlab-Token" }, 401);
  }

  // 2. Parse payload
  const raw = (await c.req.json()) as AnyGitLabWebhook;

  // ─── Pipeline webhook — trigger deferred review khi CI pass ───
  // Chỉ interested khi status=success (CI fail đã được xử lý ở MR webhook phase).
  if (raw.object_kind === "pipeline") {
    const pipeline = raw as unknown as PipelineWebhook;
    const attrs = pipeline.object_attributes;
    const status = attrs?.status;
    const projectId = attrs?.project_id;
    const sha = attrs?.sha;

    if (status !== "success") {
      return c.json({ skipped: true, reason: `pipeline-status=${status}` });
    }
    if (!projectId || !sha) {
      return c.json({ skipped: true, reason: "pipeline-missing-project-id-or-sha" });
    }

    // Lookup pending review (đăng ký khi MR webhook đến + CI đang chạy).
    const entry = consumePendingReview(projectId, sha);
    if (!entry) {
      // Không có pending — skip idempotent (MR đã review rồi, hoặc ci.require=false).
      return c.json({ skipped: true, reason: "no-pending-review" });
    }

    console.log(`[webhook] pipeline success ${projectId}@${sha.slice(0, 8)} — triggering deferred review for !${entry.payload.object_attributes.iid}`);
    // Trigger review với skipCiCheck=true (CI đã pass, không check lại).
    performReview(entry.payload, { skipCiCheck: true }).catch((err) => {
      console.error(`[webhook] uncaught deferred review error:`, err);
    });
    return c.json({ accepted: true, triggeredBy: "pipeline", sha });
  }

  // ─── Merge request webhook — flow chính ───
  if (raw.object_kind !== "merge_request") {
    return c.json({ skipped: true, reason: `object_kind=${raw.object_kind}` });
  }

  const payload = raw as unknown as MergeRequestWebhook;
  const mrIid = payload.object_attributes?.iid;

  // 3. Apply default filters (per-project config loaded later, but skip rules
  //    are cheap to evaluate with the default config first — re-check after
  //    clone if a project config narrows them further)
  const decision = shouldReview(payload, {
    review: {
      language: "vi",
      skipTitleRegex: "\\b(wip|dnr|do not review)\\b",
      skipBranchRegex: "^(wip|scratch)/.*",
    },
    scope: { enabled: false },
    llm: {},
    block: { enabled: false },
    ci: { require: false },
  });

  if (!decision.review) {
    console.log(`[webhook] skip !${mrIid} — ${decision.reason}`);
    return c.json({ skipped: true, reason: decision.reason, mrIid });
  }

  // 4. Schedule async review — DO NOT await (GitLab 10s webhook timeout)
  //    Bun handles the promise on the microtask queue.
  console.log(`[webhook] accepted !${mrIid} — scheduling review`);
  // fire-and-forget; performReview catches all its own errors
  performReview(payload).catch((err) => {
    console.error(`[webhook] uncaught review error for !${mrIid}:`, err);
  });

  // 5. Respond immediately
  return c.json({ accepted: true, mrIid });
});

/** Reject other methods on /webhook explicitly. */
app.on(["PUT", "PATCH", "DELETE"], "/webhook", (c) =>
  c.json({ error: "method not allowed" }, 405),
);

console.log(`🤖 pi-reviewer-bot v${VERSION} listening on :${PORT}`);
export default { port: PORT, fetch: app.fetch };
