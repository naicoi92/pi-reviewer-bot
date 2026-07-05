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
  enqueuePendingReview,
} from "./ciwait.ts";
import {
  fetchMrDiff,
  getMrPipelineStatus,
  listMrComments,
  mrContextFromWebhook,
  postMrNote,
  unapproveMr,
  type MrContext,
} from "./gitlab.ts";
import { completeReview, registerReview, type InFlightReview } from "./inflight.ts";
import { withLimits } from "./limiter.ts";
import { runPiReview } from "./pi.ts";
import { cloneForReview, readFileOrNull, type ClonedRepo } from "./repo.ts";
import { stats, type ReviewOutcome } from "./stats.ts";
import { PIPELINE_FAILURE_STATES, PIPELINE_RUNNING_STATES, type MergeRequestWebhook } from "./types.ts";
import { parse } from "yaml";

if (!process.env.WEBHOOK_SECRET) {
  console.warn("[webhook] WEBHOOK_SECRET not set — verification will fail open in dev only");
}

/** Hard fallback nếu env không set. 10 phút — đủ cho đa số CI pipeline. */
const DEFAULT_CI_WAIT_TIMEOUT_MS = 600_000;

/**
 * Resolve timeout đợi CI theo priority:
 *   1. `.pi/config.yaml` → `ci.waitTimeoutMs` (per-project)
 *   2. Env `CI_WAIT_TIMEOUT_MS` (server-wide default)
 *   3. Hardcoded `DEFAULT_CI_WAIT_TIMEOUT_MS` (10 phút)
 */
export function resolveCiWaitTimeoutMs(cfg: ProjectConfig): number {
  if (cfg.ci.waitTimeoutMs && cfg.ci.waitTimeoutMs > 0) {
    return cfg.ci.waitTimeoutMs;
  }
  const env = Number(process.env.CI_WAIT_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) {
    return Math.floor(env);
  }
  return DEFAULT_CI_WAIT_TIMEOUT_MS;
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
 *
 * @param payload  Webhook payload gốc.
 * @param opts.skipCiCheck  Bỏ qua CI check — dùng khi trigger từ pipeline webhook
 *                          (lúc đó CI đã pass, không cần check lại). Default false.
 */
export async function performReview(
  payload: MergeRequestWebhook,
  opts: { skipCiCheck?: boolean } = {},
): Promise<void> {
  const ctx = mrContextFromWebhook(payload);
  const log = (msg: string) => console.log(`[review !${ctx.mrIid}] ${msg}`);
  log(`start — ${ctx.projectPath} @ ${ctx.sourceBranch}`);

  // BUG 3 fix: register review mới — nếu có review cũ cho cùng MR IID đang chạy,
  // abort nó (session.abort() qua AbortSignal). Tránh 2 review song song.
  const inflight: InFlightReview = registerReview(payload);

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
            log(`loaded config — language=${cfg.review.language} block=${cfg.block.enabled} ci=${cfg.ci.require}`);
          } catch (err) {
            log(`warn — config parse failed: ${err}; using defaults`);
          }
        }
      }

      // ─── CI wait mode ────────────────────────────────────────
      // Khi `ci.require: true`, check pipeline status trước khi review:
      //   - CI running → enqueue pending, đợi pipeline webhook, return.
      //   - CI failed/canceled/skipped → skip + post note (+ unapprove nếu block).
      //   - CI pass hoặc repo chưa setup CI → proceed review.
      // `skipCiCheck=true` (từ pipeline webhook trigger) → bỏ qua block này.
      if (cfg.ci.require && !opts.skipCiCheck) {
        const ciAction = await checkCiAndWait(payload, cfg, log);
        if (ciAction === "deferred") {
          // Đã enqueue, bot sẽ review khi pipeline webhook đến.
          outcome = "skipped";
          return;
        }
        if (ciAction === "skipped") {
          // CI fail (hoặc bị skip do config) → không review, đã post note.
          outcome = "skipped";
          return;
        }
        // ciAction === "proceed" → fall through review như bình thường.
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
        abortSignal: inflight.abortController.signal,
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

    // BUG 3 fix: review bị abort do push commit mới (review mới đã thay thế).
    // KHÔNG post note, KHÔNG unapprove — review mới sẽ lo cả 2.
    if (inflight.abortController.signal.aborted || /aborted/i.test(msg)) {
      log(`cancelled — superseded by newer push, skipping outcome`);
      outcome = "skipped";
      return;
    }

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
    // Clear inflight entry để review kế tiếp (cùng MR) không bị abort nhầm.
    completeReview(ctx.projectId, ctx.mrIid);
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

// ─── CI wait helpers ─────────────────────────────────────────

/** Marker string trong note body để nhận diện note "⏸ Đợi CI" cho dedup. */
const CI_WAIT_NOTE_MARKER = "⏸ Đợi CI pass";

/**
 * Check xem bot đã post note "⏸ Đợi CI" cho cùng SHA chưa.
 * Tránh duplicate note khi dev push liên tiếp trong lúc CI đang chạy.
 *
 * Match cả marker (text cố định) LẪN SHA (backtick-wrapped) — note cũ cho
 * SHA trước vẫn được giữ lại (lịch sử), chỉ skip note mới nếu cùng SHA.
 */
async function hasCiWaitNoteAlready(
  ctx: MrContext,
  sha: string,
): Promise<boolean> {
  const result = await listMrComments(ctx);
  if (!result.ok) return false; // fail-open: post note để user biết
  return result.comments.some(
    (c) => c.body.includes(CI_WAIT_NOTE_MARKER) && c.body.includes(`\`${sha}\``),
  );
}

/** Kết quả CI check — quyết định nhánh xử lý trong performReview. */
type CiCheckResult = "proceed" | "deferred" | "skipped";

/**
 * Check pipeline status, decide tiếp tục review / enqueue đợi / skip.
 *
 * - CI running → `enqueuePendingReview` (deferred). Bot post note "⏸ đợi CI".
 * - CI fail → `skipped` + post note (+ unapprove nếu block).
 * - CI pass / no pipeline (lenient) → `proceed`.
 *
 * Testable: tách ra khỏi performReview để unit test mock GitLab API dễ hơn.
 */
export async function checkCiAndWait(
  payload: MergeRequestWebhook,
  cfg: ProjectConfig,
  log: (msg: string) => void,
): Promise<CiCheckResult> {
  const ctx = mrContextFromWebhook(payload);
  const result = await getMrPipelineStatus(ctx);

  // Edge case: repo chưa setup CI (no pipeline). Lenient default → review anyway.
  // Lý do: không block team chưa có CI; bot vẫn có giá trị review code.
  if (!result.hasPipeline) {
    log(`ci: no pipeline found — review anyway (lenient)`);
    return "proceed";
  }

  const { status, sha } = result;

  if (PIPELINE_RUNNING_STATES.has(status)) {
    // CI đang chạy → enqueue đợi pipeline webhook.
    const timeoutMs = resolveCiWaitTimeoutMs(cfg);
    enqueuePendingReview(payload, timeoutMs, (timedOutPayload) => {
      // Timeout fire — CI chạy quá lâu. Review anyway + log warning.
      const tc = mrContextFromWebhook(timedOutPayload);
      console.log(
        `[review !${tc.mrIid}] ci timeout after ${timeoutMs}ms — proceeding review anyway`,
      );
      // Re-trigger review với skipCiCheck=true để tránh loop.
      performReview(timedOutPayload, { skipCiCheck: true }).catch((err) => {
        console.error(`[review !${tc.mrIid}] ci-timeout review error:`, err);
      });
    });
    log(`ci: pipeline ${status} — enqueued, will review on pipeline success (timeout ${timeoutMs}ms)`);

    // Dedup note: chỉ post "⏸ Đợi CI" nếu chưa post cho cùng SHA.
    // Tránh spam note khi dev push liên tiếp trong lúc CI đang chạy.
    if (await hasCiWaitNoteAlready(ctx, sha)) {
      log(`ci: note already posted for SHA ${sha} — skipping duplicate`);
    } else {
      await postMrNote(
        ctx,
        `## ${CI_WAIT_NOTE_MARKER}\n\nPipeline đang chạy (\`${status}\`). Bot sẽ review tự động khi CI pass.\n\n_SHA: \`${sha}\` · Timeout: ${Math.floor(timeoutMs / 1000)}s_`,
      ).catch(() => void 0);
    }
    return "deferred";
  }

  if (PIPELINE_FAILURE_STATES.has(status)) {
    // CI fail/canceled/skipped → skip review + post note.
    log(`ci: pipeline ${status} — skip review (CI failed)`);
    await postMrNote(
      ctx,
      `## 🚫 CI ${status} — skip review\n\nPipeline \`${status}\`. Bot sẽ không review cho commit này.\n\n_Fix CI và push commit mới để trigger review lại._`,
    ).catch(() => void 0);
    if (cfg.block.enabled) {
      await unapproveMr(ctx).catch(() => void 0);
    }
    return "skipped";
  }

  // status === "success" (hoặc các status khác như manual — coi như pass).
  log(`ci: pipeline ${status} — proceed review`);
  return "proceed";
}
