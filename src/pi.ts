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
	DefaultResourceLoader,
	SessionManager,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { mkdir } from "node:fs/promises";
import { exists } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MrContext } from "./gitlab.ts";
import type { MergeRequestDiffEntry, ReviewResult } from "./types.ts";
import {
	createReviewTools,
	createInitialToolState,
	type ReviewToolState,
} from "./tools/index.ts";

/**
 * Model resolution priority (cao → thấp):
 *   1. .pi/config.yaml → llm.model (per-project, sole source — DEFAULT_MODEL env đã purge)
 *   2. Pi auto-detect (lấy provider đầu tiên có API key trong env)
 *
 * Pi SDK supports 40+ providers: Z.ai, OpenAI, Anthropic, DeepSeek, Google,
 * Bedrock, Vertex, Ollama, v.v. Set API key env var tương ứng (ZAI_API_KEY,
 * OPENAI_API_KEY, ANTHROPIC_API_KEY, ...) — Pi tự detect.
 *
 * Xem full list: `pi --list-models` hoặc https://pi.dev/models
 */
// Pi writes settings/auth cache here — must be writable by the bot process.
// In containers the default ~/.pi may not be writable, so we override.
const PI_AGENT_DIR = process.env.PI_AGENT_DIR ?? "/tmp/pi-agent";

/**
 * Base system prompt — bot-controlled, chứa hướng dẫn dùng 12 tools + workflow.
 *
 * File `agents/code-reviewer.md` ở bot source được load runtime làm system prompt
 * gốc. Project KHÔNG copy file này — họ chỉ append rules riêng qua
 * `.pi/REVIEW_RULES.md` (xem `loadProjectRules`).
 *
 * Path resolution fallback chain (dev + compiled binary):
 *   1. `BASE_PROMPT_PATH` env var (override explicit)
 *   2. `<bot-src>/../agents/code-reviewer.md` — dev mode (bun run dev)
 *   3. `/app/agents/code-reviewer.md` — Docker compiled binary (Dockerfile COPY)
 *   4. `./agents/code-reviewer.md` — cwd-relative (systemd, local run)
 *
 * Khi Bun `--compile` standalone, `import.meta.dir` trỏ tới virtual FS (`/$bunfs/root`)
 * → không dùng được. Phải dùng runtime path (env or hard-coded Docker path).
 */
const BASE_PROMPT_CANDIDATES = [
	process.env.BASE_PROMPT_PATH,
	join(dirname(import.meta.dir), "agents", "code-reviewer.md"), // dev: src/../agents
	"/app/agents/code-reviewer.md", // Docker compiled binary
	join(process.cwd(), "agents", "code-reviewer.md"), // systemd / local
].filter((p): p is string => Boolean(p));

let cachedBasePrompt: string | undefined;
async function loadBasePrompt(): Promise<string> {
	if (cachedBasePrompt !== undefined) return cachedBasePrompt;
	const errors: string[] = [];
	for (const candidate of BASE_PROMPT_CANDIDATES) {
		try {
			const file = Bun.file(candidate);
			if (await file.exists()) {
				cachedBasePrompt = await file.text();
				console.log(
					`[pi] base prompt loaded from ${candidate} (${cachedBasePrompt.length} chars)`,
				);
				return cachedBasePrompt;
			}
		} catch (e) {
			errors.push(
				`${candidate}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	throw new Error(
		`Cannot load base prompt. Tried:\n${BASE_PROMPT_CANDIDATES.map((p) => `  - ${p}`).join("\n")}\nErrors: ${errors.join("; ")}`,
	);
}

/**
 * Project-specific review rules — optional, append vào base prompt.
 *
 * Project chỉ viết info về project của họ (stack, conventions, scope, license
 * policy). Bot tự lo phần hướng dẫn tools — project KHÔNG phải copy.
 *
 * Lookup order (first match wins):
 *   1. `.pi/REVIEW_RULES.md` — canonical path (recommend)
 *   2. `.pi/agents/code-reviewer.md` — legacy path (deprecated, warn)
 *
 * Returns null nếu project không có file → bot review với default base prompt.
 */
const PROJECT_RULES_MAX_BYTES = 50_000;

async function loadProjectRules(repoDir: string): Promise<string | null> {
	const candidates = [
		{ path: ".pi/REVIEW_RULES.md", warn: false },
		{ path: ".pi/agents/code-reviewer.md", warn: true }, // legacy
	];
	for (const c of candidates) {
		const abs = join(repoDir, c.path);
		if (!(await exists(abs))) continue;
		if (c.warn) {
			console.warn(
				`[pi] ${c.path} is deprecated — migrate to .pi/REVIEW_RULES.md (will be removed in v0.5)`,
			);
		}
		const text = await Bun.file(abs).text();
		if (text.length > PROJECT_RULES_MAX_BYTES) {
			console.warn(
				`[pi] ${c.path} is ${text.length} bytes (> ${PROJECT_RULES_MAX_BYTES}) — truncating`,
			);
			return (
				text.slice(0, PROJECT_RULES_MAX_BYTES) +
				"\n\n[... project rules truncated]"
			);
		}
		return text;
	}
	return null;
}

/**
 * Build the user prompt với MR context + diff.
 *
 * System prompt (hướng dẫn tools + workflow) đã được load qua ResourceLoader
 * → không lặp lại ở đây. User prompt chỉ chứa data cụ thể của MR này.
 */
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
			`\n\n[⚠️ DIFF TRUNCATED at ${DIFF_CAP} chars. ${fullDiff.length - DIFF_CAP} chars omitted. Call fetch_files([paths]) to read remaining files.]`
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
 * D19 — 2 cơ chế phòng thủ verdict:
 *   1. Session retry (MAX_SESSION_RETRIES): session crash (stream/JSON/network) →
 *      fresh session, review lại từ đầu (mất context nhưng tiếp tục được).
 *   2. Verdict remind (MAX_VERDICT_REMINDS): cùng session, AI end turn chưa verdict →
 *      nhắc trong cùng context (rẻ ~5s vs retry ~3min).
 *
 * BUG gốc (MR !15): AI burn budget vào web_search/tool calls, end turn mà chưa gọi
 * approve_mr/request_changes → outcome=inconclusive → job FAIL → user re-run pipeline.
 */
const MAX_SESSION_RETRIES = 2;
const MAX_VERDICT_REMINDS = 2;

export { MAX_SESSION_RETRIES, MAX_VERDICT_REMINDS };

/**
 * Build verdict reminder include state — AI biết bước tiếp.
 * Giữ context (cùng session), rẻ hơn retry ~3min (setup session + re-read diff).
 */
export function buildVerdictReminder(state: ReviewToolState): string {
	const parts: string[] = [
		"You have not issued a verdict yet. The review MUST end with a verdict.",
		"",
		"Current state:",
		`- summary posted: ${state.summaryPosted ? "yes" : "NO"}`,
		`- critical comments: ${state.criticalCount}`,
		`- inline comments posted: ${state.inlineCommentsPosted}`,
	];

	if (!state.summaryPosted) {
		parts.push(
			"",
			"Next step: call post_summary(markdown) with your overall assessment NOW.",
		);
	} else if (state.criticalCount > 0) {
		parts.push(
			"",
			`Next step: call request_changes(reason) — ${state.criticalCount} critical issue(s) block approval.`,
		);
	} else {
		parts.push(
			"",
			"Next step: call approve_mr(rationale) — summary posted, 0 critical.",
		);
	}
	parts.push("", "Do NOT call any other tool. Issue the verdict immediately.");
	return parts.join("\n");
}

/**
 * Resolve model + validate format. Return resolved model hoặc error string.
 * Empty modelId → undefined (Pi auto-pick from auth).
 */
function resolveModel(
	modelId: string,
):
	| { ok: true; model?: ReturnType<typeof getBuiltinModel> }
	| { ok: false; error: string } {
	if (!modelId) return { ok: true }; // Pi auto-pick
	const slashIdx = modelId.indexOf("/");
	if (slashIdx <= 0) {
		return {
			ok: false,
			error: `Invalid model '${modelId}'. Expected format 'provider/model' e.g. 'zai/glm-5.2', 'openai/gpt-4o'.`,
		};
	}
	const provider = modelId.slice(0, slashIdx);
	const model = modelId.slice(slashIdx + 1);
	try {
		return {
			ok: true,
			model: getBuiltinModel(provider as never, model as never),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `Model '${modelId}' not found. Run 'pi --list-models' to see available. Original: ${msg}`,
		};
	}
}

/**
 * Build session options (once per review — reused across retries).
 * Tools + state persist across retry attempts (approve/comment idempotent).
 */
async function buildSessionOpts(opts: {
	repoDir: string;
	model?: ReturnType<typeof getBuiltinModel>;
	tools: ToolDefinition<any, any, any>[];
}): Promise<Parameters<typeof createAgentSession>[0]> {
	const toolNames = opts.tools.map((t) => t.name);
	// IMPORTANT: dùng `tools: [...]` allowlist để Pi expose customTools cho AI.
	// `noTools: "all"` disable built-in NHƯNG cũng làm Pi không register customTools
	// vào active tool list → AI không thấy tools (verified empirical).
	let sessionOpts: Record<string, unknown> = {
		cwd: opts.repoDir,
		agentDir: PI_AGENT_DIR,
		noTools: "all", // disable built-in read/bash/edit/write
		tools: toolNames, // expose custom tools (critical — without this AI sees no tools)
		customTools: opts.tools,
		sessionManager: SessionManager.inMemory(opts.repoDir),
	};
	if (opts.model) sessionOpts = { ...sessionOpts, model: opts.model };

	// Build ResourceLoader để inject base prompt + project rules (bot-controlled).
	const basePrompt = await loadBasePrompt();
	const projectRules = await loadProjectRules(opts.repoDir);
	const appendSystemPrompt = projectRules ? [projectRules] : [];
	console.log(
		`[pi] system prompt: base=${basePrompt.length} chars, project append=${projectRules ? projectRules.length : 0} chars`,
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: opts.repoDir,
		agentDir: PI_AGENT_DIR,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPrompt: basePrompt,
		appendSystemPrompt,
	});
	await resourceLoader.reload();
	sessionOpts = { ...sessionOpts, resourceLoader };
	return sessionOpts as Parameters<typeof createAgentSession>[0];
}

/**
 * Outcome của 1 session attempt (review hoặc remind).
 *   verdict=true → AI đã gọi approve_mr/request_changes.
 *   verdict=false → AI end turn chưa verdict (cần remind hoặc retry).
 */
interface AttemptOutcome {
	verdict: boolean;
	error?: string; // session crash (stream/JSON/network) → trigger retry
	markdown: string;
	events: AgentSessionEvent[];
}

/**
 * Run 1 session: create → prompt → wait agent_end → remind loop → dispose.
 *
 * Remind loop (MAX_VERDICT_REMINDS): nếu AI end turn chưa verdict (state.approved &&
 * state.changesRequested đều false), re-prompt verdict reminder trong cùng session.
 * Rẻ (~5s) vs retry (~3min setup session mới).
 */
async function runSessionAttempt(args: {
	sessionOpts: Parameters<typeof createAgentSession>[0];
	state: ReviewToolState;
	initialPrompt: string;
	timeoutMs: number;
	attempt: number;
}): Promise<AttemptOutcome> {
	const { sessionOpts, state, initialPrompt, timeoutMs, attempt } = args;
	const { session } = await createAgentSession(sessionOpts);

	// Force sequential tool execution. SDK default = "parallel" → guardrail race:
	// khi AI gọi post_summary + approve_mr cùng batch, approve_mr check
	// state.summaryPosted TRƯỚC khi post_summary set nó → block sai → remind loop
	// vô tận → inconclusive (BUG MR !18).
	(session as { agent?: { toolExecution: string } }).agent!.toolExecution =
		"sequential";

	let markdown = "";
	const events: AgentSessionEvent[] = [];

	const unsubscribe = session.subscribe((evt: AgentSessionEvent) => {
		events.push(evt);
		const t = evt.type as string;
		if (t === "tool_execution_start" || t === "tool_call") {
			const toolName =
				(evt as { name?: string; toolName?: string }).name ??
				(evt as { toolName?: string }).toolName ??
				"unknown";
			console.log(`[pi] (attempt ${attempt}) tool call: ${toolName}`);
		}
		if (t === "tool_execution_end") {
			const e = evt as {
				toolName: string;
				result?: { content?: Array<{ type: string; text?: string }> };
				isError?: boolean;
			};
			const text = e.result?.content
				?.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join(" ")
				.slice(0, 200);
			console.log(
				`[pi] (attempt ${attempt}) tool result ${e.toolName}${e.isError ? " [ERROR]" : ""}: ${text}`,
			);
		}
		if (
			t === "message_end" &&
			(evt as { message?: { role?: string } }).message?.role === "assistant"
		) {
			for (const c of (
				evt as { message: { content: Array<{ type: string; text?: string }> } }
			).message.content) {
				if (c.type === "text" && typeof c.text === "string") {
					markdown += c.text;
				}
			}
		}
	});

	const verdictIssued = () => state.approved || state.changesRequested;

	try {
		// Turn 1: full review prompt.
		await runOneTurn(session, initialPrompt, timeoutMs);
		if (verdictIssued()) return { verdict: true, markdown, events };

		// Remind loop: same session, cheaper than retry (~5s vs ~3min).
		for (let remind = 1; remind <= MAX_VERDICT_REMINDS; remind++) {
			console.warn(
				`[pi] (attempt ${attempt}) verdict remind ${remind}/${MAX_VERDICT_REMINDS} — AI ended turn without verdict`,
			);
			await runOneTurn(session, buildVerdictReminder(state), timeoutMs);
			if (verdictIssued()) {
				console.log(`[pi] (attempt ${attempt}) verdict after remind ${remind}`);
				return { verdict: true, markdown, events };
			}
		}
		return { verdict: false, markdown, events };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		console.warn(`[pi] (attempt ${attempt}) session error: ${error}`);
		return { verdict: false, error, markdown, events };
	} finally {
		unsubscribe();
		session.dispose();
	}
}

/**
 * Đợi SDK sẵn sàng nhận prompt mới (isStreaming=false).
 *
 * BUG (MR !17): remind turn gọi session.prompt() ngay sau khi agent_end fire,
 * nhưng SDK reset isStreaming *sau* khi emit agent_end (post-processing: flush
 * tool results, cleanup state). Window này → prompt() throw
 * "Agent is already processing". Poll isStreaming cho đến false để đóng gap.
 */
export async function waitForStreamingIdle(
	session: { isStreaming: boolean },
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (session.isStreaming) {
		if (Date.now() >= deadline) {
			throw new Error(
				`session still streaming after ${timeoutMs}ms (isStreaming stuck)`,
			);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

/**
 * Run 1 turn: wait idle → prompt → wait agent_end. Abort on timeout.
 *
 * session.prompt resolves khi input queued, KHÔNG phải khi agent done →
 * race prompt() vs agentEnded promise để detect hang.
 *
 * Defensive: dù đã wait idle, race window vẫn có thể → "already processing".
 * Catch → đợi idle thêm → retry 1 lần.
 */
async function runOneTurn(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	text: string,
	timeoutMs: number,
): Promise<void> {
	let resolveEnd!: () => void;
	let rejectEnd!: (e: Error) => void;
	const ended = new Promise<void>((resolve, reject) => {
		resolveEnd = resolve;
		rejectEnd = reject;
	});

	const unsub = session.subscribe((evt: AgentSessionEvent) => {
		if ((evt.type as string) === "agent_end") resolveEnd();
	});

	const handle = setTimeout(() => {
		console.warn(`[pi] turn exceeded ${timeoutMs}ms — aborting`);
		session.abort().catch(() => void 0);
		rejectEnd(new Error(`review exceeded ${timeoutMs}ms`));
	}, timeoutMs);

	try {
		await promptWithIdleRetry(session, text);
		await ended;
	} finally {
		clearTimeout(handle);
		unsub();
	}
}

/**
 * Prompt với wait-idle + 1 retry khi gặp "already processing".
 * Race window giữa agent_end emit và SDK reset isStreaming → prompt() throw.
 */
async function promptWithIdleRetry(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	text: string,
): Promise<void> {
	await waitForStreamingIdle(session);
	try {
		await session.prompt(text);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("already processing")) throw err;
		console.warn(`[pi] prompt race (still processing) — wait idle + retry`);
		await waitForStreamingIdle(session);
		await session.prompt(text);
	}
}

/**
 * Run a review with Pi SDK in-process, with session retry + verdict remind (D19).
 *
 * Model resolution: opts.model (from .pi/config.yaml llm.model) > Pi auto-detect.
 * Format: "provider/model" e.g. "zai/glm-5.2", "openai/gpt-4o", "deepseek/deepseek-chat".
 */
export async function runPiReview(opts: {
	ctx: MrContext;
	repoDir: string;
	diffEntries: MergeRequestDiffEntry[];
	/** "provider/model" e.g. "zai/glm-5.2". Override from .pi/config.yaml. */
	model?: string;
	/** Max tool calls (purged từ env — từ cfg.review.limits.maxToolCalls). */
	maxToolCalls?: number;
	/** Review timeout ms per turn (purged từ env — từ cfg.review.limits.timeoutMs). */
	timeoutMs?: number;
}): Promise<PiReviewResult> {
	const startedAt = Date.now();
	const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;

	// Validate model up-front (fail fast, no retry).
	const resolved = resolveModel(opts.model ?? "");
	if (!resolved.ok) {
		return {
			ok: false,
			markdown: "",
			eventCount: 0,
			error: resolved.error,
			durationMs: Date.now() - startedAt,
			toolState: createInitialToolState(),
		};
	}

	// Tool state — shared across all attempts (tools idempotent: post_summary/approve re-post OK).
	const toolState = createInitialToolState();
	const toolCtx = {
		mrContext: opts.ctx,
		repoDir: opts.repoDir,
		diffEntries: opts.diffEntries,
		state: toolState,
		maxToolCalls: opts.maxToolCalls ?? 30,
	};
	const tools = createReviewTools(toolCtx);

	// Ensure agent dir exists (Pi writes settings/auth cache here) BEFORE creating session.
	await mkdir(PI_AGENT_DIR, { recursive: true });

	const sessionOpts = await buildSessionOpts({
		repoDir: opts.repoDir,
		model: resolved.model,
		tools,
	});
	const initialPrompt = buildPrompt({
		ctx: opts.ctx,
		diffEntries: opts.diffEntries,
	});

	let allMarkdown = "";
	let allEvents: AgentSessionEvent[] = [];
	let lastError: string | undefined;

	// Retry loop: session crash (error) → fresh session, review lại từ đầu.
	// verdict=false (AI not crash, just not verdict) → KHÔNG retry (remind đã thử trong attempt).
	for (let attempt = 1; attempt <= MAX_SESSION_RETRIES + 1; attempt++) {
		console.log(`[pi] session attempt ${attempt}/${MAX_SESSION_RETRIES + 1}`);
		const outcome = await runSessionAttempt({
			sessionOpts,
			state: toolState,
			initialPrompt,
			timeoutMs,
			attempt,
		});
		allMarkdown += outcome.markdown;
		allEvents = allEvents.concat(outcome.events);

		if (outcome.verdict) {
			return {
				ok: true,
				markdown: allMarkdown,
				eventCount: allEvents.length,
				durationMs: Date.now() - startedAt,
				toolState,
			};
		}

		if (outcome.error) {
			// Session crash → retry fresh session (lose context but continue).
			lastError = outcome.error;
			if (attempt <= MAX_SESSION_RETRIES) {
				console.warn(
					`[pi] attempt ${attempt} crashed (${outcome.error}) — retrying`,
				);
			}
		} else {
			// AI not crash, just not verdict after remind loop → không retry (waste).
			console.warn(
				`[pi] attempt ${attempt} no verdict after ${MAX_VERDICT_REMINDS} reminds — giving up`,
			);
			return {
				ok: true, // session ran OK, just no verdict → inconclusive (not error)
				markdown: allMarkdown,
				eventCount: allEvents.length,
				durationMs: Date.now() - startedAt,
				toolState,
			};
		}
	}

	// All session attempts crashed.
	return {
		ok: false,
		markdown: allMarkdown,
		eventCount: allEvents.length,
		error: lastError ?? "all session attempts failed",
		durationMs: Date.now() - startedAt,
		toolState,
	};
}
