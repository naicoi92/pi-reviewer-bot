/**
 * Webhook handler — verify token, filter events, orchestrate Pi review.
 *
 * Critical rule: respond to GitLab within 10 seconds. The Pi review itself
 * takes 30s-5min — we MUST schedule it async and return 200 first.
 *
 * Flow:
 *   1. timingSafeEqual(X-Gitlab-Token, WEBHOOK_SECRET)
 *   2. payload.object_kind === "merge_request"
 *   3. action in [open, update]; for update require changes.last_commit
 *   4. skip WIP/dnr title + wip/scratch branch
 *   5. schedule async review (withLimits)
 *   6. return 200 { accepted: true }
 */

import { timingSafeEqual } from "node:crypto";
import { DEFAULT_CONFIG, mergeConfig, type ProjectConfig } from "./config.ts";
import {
  fetchMrDiff,
  mrContextFromWebhook,
  postMrNote,
  unapproveMr,
} from "./gitlab.ts";
import { withLimits } from "./limiter.ts";
import { runPiReview } from "./pi.ts";
import { cloneForReview, readFileOrNull, type ClonedRepo } from "./repo.ts";
import { stats, type ReviewOutcome } from "./stats.ts";
import type { MergeRequestWebhook } from "./types.ts";
import { parse } from "yaml";

if (!process.env.WEBHOOK_SECRET) {
  console.warn("[webhook] WEBHOOK_SECRET not set — verification will fail open in dev only");
}

/** Filter result returned synchronously to GitLab. */
export interface WebhookAcceptResult {
  accepted: boolean;
  reason?: string;
  mrIid?: number;
}

/** Verify the X-Gitlab-Token header in constant time. */
export function verifyToken(received: string | null): boolean {
  const secret = process.env.WEBHOOK_SECRET ?? "";
  if (!secret) {
    // Dev convenience: no secret configured = accept all from localhost.
    return process.env.NODE_ENV !== "production";
  }
  if (!received) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Decide whether the webhook should trigger a review (synchronous check). */
export function shouldReview(
  payload: MergeRequestWebhook,
  cfg: ProjectConfig,
): { review: boolean; reason?: string } {
  const mr = payload.object_attributes;

  if (mr.draft || mr.work_in_progress) {
    return { review: false, reason: "draft" };
  }

  // Bug fix: thêm "reopen" vào whitelist (trước đây chỉ có open/update).
  // Reopen = MR đóng rồi mở lại → cần review lại như open.
  // "approved"/"unapproved"/"mark_as_draft"/... vẫn skip (không liên quan review code).
  const REVIEWABLE_ACTIONS = new Set(["open", "update", "reopen"]);
  if (!REVIEWABLE_ACTIONS.has(mr.action)) {
    return { review: false, reason: `action=${mr.action}` };
  }

  // Bug fix: check last_commit qua object_attributes.last_commit (luôn present)
  // thay vì changes.last_commit.current (GitLab thường không gửi field này
  // trong update event → mọi push commit mới bị skip sai).
  //
  // Logic:
  // - open/reopen → luôn review (MR mới activate)
  // - update → chỉ review nếu MR thực sự có commit (object_attributes.last_commit tồn tại)
  //   Tránh review thừa khi chỉ edit title/description/labels.
  if (mr.action === "update" && !mr.last_commit) {
    return { review: false, reason: "update-without-commit" };
  }
  try {
    const titleRe = new RegExp(cfg.review.skipTitleRegex, "i");
    if (titleRe.test(mr.title)) {
      return { review: false, reason: "title-skip-regex" };
    }
  } catch {
    /* bad regex — fall through */
  }
  try {
    const branchRe = new RegExp(cfg.review.skipBranchRegex);
    if (branchRe.test(mr.source_branch)) {
      return { review: false, reason: "branch-skip-regex" };
    }
  } catch {
    /* bad regex — fall through */
  }
  return { review: true };
}

/**
 * End-to-end review pipeline (Mức 3 full tool).
 *
 * Pi SDK drives the review: AI calls tools (post_inline_comment, post_summary,
 * approve_mr/request_changes) directly. Bot chỉ post-check fail-safe:
 * nếu AI không gọi approve_mr (crash/timeout) → bot unapprove.
 */
export async function performReview(payload: MergeRequestWebhook): Promise<void> {
  const ctx = mrContextFromWebhook(payload);
  const log = (msg: string) => console.log(`[review !${ctx.mrIid}] ${msg}`);
  log(`start — ${ctx.projectPath} @ ${ctx.sourceBranch}`);

  let repo: ClonedRepo | undefined;
  let cfg: ProjectConfig = structuredClone(DEFAULT_CONFIG);
  const startedAt = Date.now();
  let outcome: ReviewOutcome = "error";

  try {
    await withLimits(ctx.projectPath, async () => {
      log(`acquired review slot`);

      repo = await cloneForReview(payload);
      log(`cloned to ${repo.dir} (config: ${repo.hasPiConfig})`);

      // Load per-project config (.pi/config.yaml or fallback .pi/)
      if (repo.hasPiConfig) {
        const raw =
          (await readFileOrNull(repo.dir, ".pi/config.yaml")) ??
          (await readFileOrNull(repo.dir, ".pi/config.yaml"));
        if (raw) {
          try {
            cfg = mergeConfig(parse(raw));
            log(`loaded config — language=${cfg.review.language} block=${cfg.block.enabled}`);
          } catch (err) {
            log(`warn — config parse failed: ${err}; using defaults`);
          }
        }
      }

      // Fetch diff
      const diffEntries = await fetchMrDiff(ctx);
      log(`fetched ${diffEntries.length} file diffs`);

      if (diffEntries.length === 0) {
        await postMrNote(ctx, "## 🤖 Review\n\nNo file changes detected — nothing to review.");
        outcome = "skipped";
        return;
      }

      // Run Pi review (tools auto-approve / auto-comment)
      const result = await runPiReview({
        ctx,
        repoDir: repo.dir,
        diffEntries,
        model: cfg.llm.model,
      });
      log(`pi finished in ${result.durationMs}ms — ok=${result.ok} events=${result.eventCount}`);

      // Derive outcome SOLELY from toolState (single source of truth).
      // This avoids the race where outcome was set mid-callback before post-approve
      // errors could happen.
      const ts = result.toolState;
      log(
        `tool state: summary=${ts.summaryPosted} inline=${ts.inlineCommentsPosted} critical=${ts.criticalCount} approved=${ts.approved} changesRequested=${ts.changesRequested}`,
      );

      if (!result.ok) {
        // Pi crashed or timed out
        if (cfg.block.enabled) {
          await unapproveMr(ctx).catch(() => void 0);
        }
        await postMrNote(
          ctx,
          `## 🤖 Review failed\n\n⚠️ **Bot error:** ${result.error ?? "unknown"}\n\n_Merge blocked until bot succeeds. Push to retry, or manually approve to override._`,
        ).catch(() => void 0);
        outcome = "error";
      } else if (cfg.block.enabled) {
        if (ts.approved) {
          outcome = "approved";
        } else if (ts.changesRequested) {
          outcome = "unapproved";
        } else {
          // AI finished without verdict — conservative unapprove
          await unapproveMr(ctx).catch(() => void 0);
          await postMrNote(
            ctx,
            `## ⚠️ Review inconclusive\n\nBot finished review but did not issue a verdict.\n\n**Summary:** ${ts.summaryText || "(no summary posted)"}\n\n_Inconclusive review blocks merge. Push a new commit to retry, or manually approve to override._`,
          ).catch(() => void 0);
          outcome = "unapproved";
          log(`inconclusive — fail-safe unapproved`);
        }
      } else {
        // No gate — outcome reflects verdict without blocking
        outcome = ts.approved
          ? "approved"
          : ts.changesRequested
            ? "unapproved"
            : "skipped";
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[review !${ctx.mrIid}] error:`, msg);
    outcome = "error";
    await postMrNote(
      ctx,
      `## 🤖 Review failed\n\n⚠️ **Bot error:** ${msg}\n\n_Bot will retry on next push._`,
    ).catch(() => void 0);
    if (cfg?.block.enabled) {
      await unapproveMr(ctx).catch(() => void 0);
      console.log(`[review !${ctx.mrIid}] unapproved after error (block=true)`);
    }
  } finally {
    await repo?.cleanup();
    const durationMs = Date.now() - startedAt;
    stats.record({
      projectPath: ctx.projectPath,
      mrIid: ctx.mrIid,
      outcome,
      durationMs,
    });
    log(`done — outcome=${outcome} duration=${durationMs}ms`);
  }
}
