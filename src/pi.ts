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

/**
 * Model resolution priority (cao → thấp):
 *   1. .pi/config.yaml → llm.model (per-project override)
 *   2. DEFAULT_MODEL env var (deployment-wide default)
 *   3. Pi auto-detect (lấy provider đầu tiên có API key trong env)
 *
 * Pi SDK supports 40+ providers: Z.ai, OpenAI, Anthropic, DeepSeek, Google,
 * Bedrock, Vertex, Ollama, v.v. Set API key env var tương ứng (ZAI_API_KEY,
 * OPENAI_API_KEY, ANTHROPIC_API_KEY, ...) — Pi tự detect.
 *
 * Xem full list: `pi --list-models` hoặc https://pi.dev/models
 */
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "";
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
 *
 * Model resolution:
 *   opts.model (from .pi/config.yaml) > DEFAULT_MODEL env > Pi auto-detect
 *
 * Format: "provider/model" e.g. "zai/glm-5.2", "openai/gpt-4o", "deepseek/deepseek-chat".
 * Empty/undefined → Pi picks first available provider from auth.
 */
export async function runPiReview(opts: {
  ctx: MrContext;
  repoDir: string;
  diffEntries: MergeRequestDiffEntry[];
  /** "provider/model" e.g. "zai/glm-5.2". Override from .pi/config.yaml. */
  model?: string;
  /**
   * External abort signal — fire khi review mới đến (push commit mới) hoặc
   * bot shutdown. Khi fire: `session.abort()` → SDK reject `agentEnded` →
   * caller catch AbortError → return không post note.
   *
   * Tách riêng với REVIEW_TIMEOUT_MS timeout (cũng gọi session.abort() nhưng
   * với lý do khác). Cả 2 nguồn dùng chung cơ chế abort SDK.
   */
  abortSignal?: AbortSignal;
}): Promise<PiReviewResult> {
  const startedAt = Date.now();
  const modelId = opts.model || DEFAULT_MODEL;  // empty string falls through to Pi default

  // Tool state — shared across all tools in this review
  const toolState = createInitialToolState();
  const toolCtx = {
    mrContext: opts.ctx,
    repoDir: opts.repoDir,
    diffEntries: opts.diffEntries,
    state: toolState,
  };
  const tools: ToolDefinition<any, any, any>[] = createReviewTools(toolCtx);

  // Resolve model: explicit "provider/model" → getBuiltinModel; empty → let Pi auto-pick
  // IMPORTANT: dùng `tools: [...]` allowlist để Pi expose customTools cho AI.
  // `noTools: "all"` disable built-in NHƯNG cũng làm Pi không register customTools
  // vào active tool list → AI không thấy tools (verified empirical).
  // Fix: liệt kê tên tất cả custom tools vào `tools` allowlist.
  const toolNames = tools.map((t) => t.name);
  let sessionOpts: ConstructorParameters<typeof Object>[0] = {
    cwd: opts.repoDir,
    agentDir: PI_AGENT_DIR,
    noTools: "all",              // disable built-in read/bash/edit/write
    tools: toolNames,            // expose custom tools (critical — without this AI sees no tools)
    customTools: tools,
    sessionManager: SessionManager.inMemory(opts.repoDir),
  };

  if (modelId) {
    const slashIdx = modelId.indexOf("/");
    if (slashIdx <= 0) {
      return {
        ok: false,
        markdown: "",
        eventCount: 0,
        error: `Invalid model '${modelId}'. Expected format 'provider/model' e.g. 'zai/glm-5.2', 'openai/gpt-4o'.`,
        durationMs: Date.now() - startedAt,
        toolState,
      };
    }
    const provider = modelId.slice(0, slashIdx);
    const model = modelId.slice(slashIdx + 1);
    try {
      const resolvedModel = getBuiltinModel(provider as never, model as never);
      sessionOpts = { ...sessionOpts, model: resolvedModel };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        markdown: "",
        eventCount: 0,
        error: `Model '${modelId}' not found. Run 'pi --list-models' to see available. Original: ${msg}`,
        durationMs: Date.now() - startedAt,
        toolState,
      };
    }
  }
  // If modelId empty → don't pass `model`, Pi will auto-pick from auth.json

  // Ensure agent dir exists (Pi writes settings/auth cache here) BEFORE creating session
  await mkdir(PI_AGENT_DIR, { recursive: true });

  // Create session
  const { session } = await createAgentSession(sessionOpts as Parameters<typeof createAgentSession>[0]);

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
    // Log tool executions for debugging (helps spot "AI didn't call tools" issues)
    const t = evt.type as string;
    if (t === "tool_execution_start" || t === "tool_call") {
      const toolName = (evt as { name?: string; toolName?: string }).name
        ?? (evt as { toolName?: string }).toolName
        ?? "unknown";
      console.log(`[pi] tool call: ${toolName}`);
    }
    if (t === "message_end" && (evt as { message?: { role?: string } }).message?.role === "assistant") {
      for (const c of (evt as { message: { content: Array<{ type: string; text?: string }> } }).message.content) {
        if (c.type === "text" && typeof c.text === "string") {
          markdown += c.text;
        }
      }
    }
    if (t === "agent_end") {
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

  // External abort (vd push commit mới → registerReview abort review cũ).
  // Dùng cùng cơ chế session.abort() như timeout, nhưng lý do khác để log rõ.
  let externalAbortListener: (() => void) | undefined;
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      // Edge case: signal đã abort trước khi listener attach (race).
      const msg = "review aborted (superseded by newer push)";
      console.log(`[pi] ${msg}`);
      session.abort().catch(() => void 0);
      rejectAgentEnd(new Error(msg));
    } else {
      externalAbortListener = () => {
        const msg = "review aborted (superseded by newer push)";
        console.log(`[pi] ${msg}`);
        session.abort().catch(() => void 0);
        rejectAgentEnd(new Error(msg));
      };
      opts.abortSignal.addEventListener("abort", externalAbortListener, { once: true });
    }
  }

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
    if (externalAbortListener && opts.abortSignal) {
      opts.abortSignal.removeEventListener("abort", externalAbortListener);
    }
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
