/**
 * Pi Coding Agent SDK wrapper — in-process review.
 *
 * Dùng `createAgentSession` thay vì spawn subprocess. In-process SDK:
 *   - No subprocess overhead (~1-2s cold start vs 5-10s)
 *   - Type-safe event handling
 *   - `customTools` native — không cần shell-out để approve/comment
 *   - Z.ai provider built-in (chỉ cần ZAI_API_KEY env)
 *
 * Flow:
 *   1. createAgentSession({ cwd, model, customTools }) → { session }
 *   2. session.subscribe(listener) — collect assistant text + detect agent_end
 *   3. session.prompt(reviewPrompt) — AI chạy review, call tools qua session
 *   4. await agent_end → dispose
 *   5. Bot post-check: nếu state.approved === false → fail-safe unapprove
 */

import {
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { mkdir } from "node:fs/promises";
import type { MrContext } from "./gitlab.ts";
import type { MergeRequestDiffEntry, ReviewResult } from "./types.ts";
import { createReviewTools, createInitialToolState, type ReviewToolState } from "./tools/index.ts";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "zai/glm-5.2";
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 5 * 60 * 1000);
// Pi writes settings/auth cache here — must be writable by the bot process.
// In containers the default ~/.pi may not be writable, so we override.
const PI_AGENT_DIR = process.env.PI_AGENT_DIR ?? "/tmp/pi-agent";

/** Build the prompt with MR context + diff. */
function buildPrompt(opts: {
  ctx: MrContext;
  diffEntries: MergeRequestDiffEntry[];
}): string {
  const { ctx, diffEntries } = opts;
  const DIFF_CAP = 200_000;

  const fullDiff = diffEntries
    .map(
      (d) =>
        `--- ${d.old_path} → ${d.new_path} (${d.new_file ? "new" : d.deleted_file ? "deleted" : d.renamed_file ? "renamed" : "modified"})\n${d.diff}`,
    )
    .join("\n\n");

  const isTruncated = fullDiff.length > DIFF_CAP;
  const diffText = isTruncated
    ? fullDiff.slice(0, DIFF_CAP) +
      `\n\n[⚠️ DIFF TRUNCATED at ${DIFF_CAP} chars. ${fullDiff.length - DIFF_CAP} chars omitted. Call fetch_file(path) to read remaining files individually.]`
    : fullDiff;

  return [
    `Review Merge Request !${ctx.mrIid} for project "${ctx.projectPath}".`,
    `Branch: ${ctx.sourceBranch} → ${ctx.targetBranch}`,
    `MR URL: ${ctx.webUrl}`,
    ``,
    `## MR Title`,
    ctx.title,
    ``,
    `## MR Description`,
    ctx.description || "(no description provided)",
    ``,
    `## Available tools`,
    `Read context:`,
    `1. fetch_file(path) — read a file from the repo for additional context`,
    `2. get_issue(iid) — read GitLab issue (description, comments, labels, linked MRs)`,
    `3. list_mr_comments() — existing comments on this MR (idempotent re-review)`,
    `4. list_mr_commits() — commit history (iteration context)`,
    `5. list_wiki_pages() — list wiki slugs/titles (discover before get_wiki_page)`,
    `6. get_wiki_page(slug) — GitLab wiki page (ADRs/runbooks outside repo)`,
    `Write verdict:`,
    `7. post_inline_comment(path, line, comment, severity) — line-specific DiffNote`,
    `8. post_summary(markdown) — REQUIRED before approve/request_changes`,
    `9. approve_mr(rationale) — approve (blocked if no summary or critical issues remain)`,
    `10. request_changes(reason) — block merge`,
    ``,
    `## Workflow`,
    `1. Read AGENTS.md (if present) for project conventions and per-layer rules.`,
    `2. Read .pi/config.yaml (if present) for scope alignment settings.`,
    `3. If 'Resolves: #N' in description AND scope.enabled: call get_issue(N) to verify alignment.`,
    `4. If MR is an update (re-review): call list_mr_comments() to avoid duplicating prior feedback.`,
    `5. Review the diff. Use fetch_file when you need neighbour code.`,
    `6. If project stores ADRs/docs in Wiki: call list_wiki_pages() first, then get_wiki_page(slug).`,
    `7. Post inline comments for each issue with appropriate severity.`,
    `8. Call post_summary with your overall verdict.`,
    `9. Call approve_mr (if 0 critical) OR request_changes (if ≥1 critical).`,
    ``,
    `## Diff`,
    "```diff",
    diffText.slice(0, 200_000),
    "```",
  ].join("\n");
}

export interface PiReviewResult extends ReviewResult {
  toolState: ReviewToolState;
}

/**
 * Run a review with Pi SDK in-process.
 */
export async function runPiReview(opts: {
  ctx: MrContext;
  repoDir: string;
  diffEntries: MergeRequestDiffEntry[];
  /** "provider/model" e.g. "zai/glm-5.2". Default = env DEFAULT_MODEL. */
  model?: string;
}): Promise<PiReviewResult> {
  const startedAt = Date.now();
  const modelId = opts.model ?? DEFAULT_MODEL;
  const [provider, model] = modelId.split("/");

  // Tool state — shared across all tools in this review
  const toolState = createInitialToolState();
  const toolCtx = {
    mrContext: opts.ctx,
    repoDir: opts.repoDir,
    diffEntries: opts.diffEntries,
    state: toolState,
  };
  const tools: ToolDefinition<any, any, any>[] = createReviewTools(toolCtx);

  // Resolve model
  let resolvedModel: ReturnType<typeof getBuiltinModel>;
  try {
    resolvedModel = getBuiltinModel(provider as never, model as never);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      markdown: "",
      eventCount: 0,
      error: `Model ${modelId} not found: ${msg}`,
      durationMs: Date.now() - startedAt,
      toolState,
    };
  }

  // Ensure agent dir exists (Pi writes settings/auth cache here)
  await mkdir(PI_AGENT_DIR, { recursive: true });

  // Create session — no built-in tools, only our custom 5
  const { session } = await createAgentSession({
    cwd: opts.repoDir,
    agentDir: PI_AGENT_DIR,
    model: resolvedModel,
    noTools: "all",
    customTools: tools,
    // Ephemeral — don't persist session to disk
    sessionManager: SessionManager.inMemory(opts.repoDir),
  });

  // Subscribe to events. Use Promise-based wait for agent_end (no polling).
  let markdown = "";
  const events: AgentSessionEvent[] = [];
  let agentError: string | undefined;

  // Resolve agentEnded promise when agent_end event fires.
  let resolveAgentEnd!: () => void;
  let rejectAgentEnd!: (e: Error) => void;
  const agentEnded = new Promise<void>((resolve, reject) => {
    resolveAgentEnd = resolve;
    rejectAgentEnd = reject;
  });

  const unsubscribe = session.subscribe((evt: AgentSessionEvent) => {
    events.push(evt);
    if (evt.type === "message_end" && evt.message.role === "assistant") {
      for (const c of evt.message.content) {
        if (c.type === "text" && typeof c.text === "string") {
          markdown += c.text;
        }
      }
    }
    if (evt.type === "agent_end") {
      resolveAgentEnd();
    }
  });

  // Hard timeout — kills session AND rejects prompt() promise.
  const timeoutHandle = setTimeout(() => {
    const msg = `review exceeded ${REVIEW_TIMEOUT_MS}ms`;
    console.warn(`[pi] ${msg} — aborting session`);
    session.abort().catch(() => void 0);
    rejectAgentEnd(new Error(msg));
  }, REVIEW_TIMEOUT_MS);

  const prompt = buildPrompt({ ctx: opts.ctx, diffEntries: opts.diffEntries });

  try {
    // session.prompt resolves when input is queued (not when agent done).
    // We race prompt() vs agentEnded to detect hang.
    await Promise.race([
      session.prompt(prompt).then(() => agentEnded),
      agentEnded,
    ]);
  } catch (err) {
    agentError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeoutHandle);
    unsubscribe();
    session.dispose();
  }

  const durationMs = Date.now() - startedAt;
  if (agentError) {
    return {
      ok: false,
      markdown,
      eventCount: events.length,
      error: agentError,
      durationMs,
      toolState,
    };
  }

  return {
    ok: true,
    markdown,
    eventCount: events.length,
    durationMs,
    toolState,
  };
}
