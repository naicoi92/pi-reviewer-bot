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
		`## Diff`,
		"```diff",
		diffText.slice(0, 200_000),
		"```",
	].join("\n");
}

export interface PiReviewResult extends ReviewResult {
	toolState: ReviewToolState;
}

/** Số session attempt tối đa (1 lần đầu + retry). Cover stream crash + verdict miss. */
const MAX_SESSION_RETRIES = 2;
/** Số lần nhắc AI trong cùng session khi kết thúc turn mà chưa verdict. */
const MAX_VERDICT_REMINDS = 2;

/**
 * Reminder gửi khi AI end turn mà chưa gọi approve_mr/request_changes.
 * Include state hiện tại để AI biết bước tiếp theo cụ thể (chưa post_summary hay chưa verdict).
 */
function buildVerdictReminder(state: ReviewToolState): string {
	const summaryStatus = state.summaryPosted ? "đã post ✅" : "CHƯA post ⚠️";
	return [
		`Bạn đã kết thúc lượt review nhưng CHƯA ra verdict chính thức.`,
		``,
		`Trạng thái:`,
		`  - post_summary: ${summaryStatus}`,
		`  - critical inline comments: ${state.criticalCount}`,
		``,
		`Bắt buộc làm theo đúng thứ tự:`,
		state.summaryPosted
			? `1. Gọi ĐÚNG MỘT: approve_mr(rationale) nếu criticalCount === 0, HOẶC request_changes(reason) nếu còn critical.`
			: `1. Gọi post_summary(markdown) với verdict tổng quan.\n2. Sau đó gọi approve_mr HOẶC request_changes.`,
		``,
		`KHÔNG review lại diff. KHÔNG comment inline thêm. Chỉ hoàn thành verdict.`,
	].join("\n");
}

/** Note thêm vào review prompt khi retry session (AI biết đây là lần thử lại). */
function retryNote(attempt: number): string {
	return [
		``,
		`---`,
		`[RETRY ${attempt + 1}/${MAX_SESSION_RETRIES}: Lần trước không ra verdict hoặc bị lỗi stream. Review gọn, gọi approve_mr hoặc request_changes ngay sau post_summary.]`,
	].join("\n");
}

/** Setup cố định dùng chung cho mọi session attempt (model, prompt, resourceLoader). */
interface SessionSetup {
	reviewPrompt: string;
	resolvedModel?: ReturnType<typeof getBuiltinModel>;
	timeoutMs: number;
	resourceLoader: DefaultResourceLoader;
}

/**
 * Chạy 1 session attempt: tạo session → remind loop (turn-level) → cleanup.
 *
 * Fresh toolState + tools mỗi attempt (review context reset hoàn toàn).
 * Trong session: nếu AI end turn mà chưa verdict → nhắc (MAX_VERDICT_REMINDS lần).
 */
async function runSessionAttempt(
	setup: SessionSetup,
	opts: {
		ctx: MrContext;
		repoDir: string;
		diffEntries: MergeRequestDiffEntry[];
		maxToolCalls?: number;
	},
	attempt: number,
): Promise<PiReviewResult> {
	const startedAt = Date.now();

	// Fresh toolState + tools per attempt (review context reset hoàn toàn)
	const toolState = createInitialToolState();
	const toolCtx = {
		mrContext: opts.ctx,
		repoDir: opts.repoDir,
		diffEntries: opts.diffEntries,
		state: toolState,
		maxToolCalls: opts.maxToolCalls ?? 30,
	};
	const tools: ToolDefinition<any, any, any>[] = createReviewTools(toolCtx);
	const toolNames = tools.map((t) => t.name);

	// Build sessionOpts: base config + fresh tools allowlist + model
	// `noTools: "all"` disable built-in; `tools: toolNames` expose customTools cho AI.
	const sessionOpts = {
		cwd: opts.repoDir,
		agentDir: PI_AGENT_DIR,
		noTools: "all" as const,
		tools: toolNames,
		customTools: tools,
		sessionManager: SessionManager.inMemory(opts.repoDir),
		resourceLoader: setup.resourceLoader,
		...(setup.resolvedModel ? { model: setup.resolvedModel } : {}),
	};

	const { session } = await createAgentSession(
		sessionOpts as Parameters<typeof createAgentSession>[0],
	);

	let markdown = "";
	const events: AgentSessionEvent[] = [];
	let agentError: string | undefined;

	// Mutable turn-end resolver — reset mỗi turn (multi-turn trong cùng session).
	let resolveTurnEnd: (() => void) | null = null;
	let rejectTurnEnd: ((e: Error) => void) | null = null;

	const unsubscribe = session.subscribe((evt: AgentSessionEvent) => {
		events.push(evt);
		const t = evt.type as string;
		if (t === "tool_execution_start" || t === "tool_call") {
			const toolName =
				(evt as { name?: string; toolName?: string }).name ??
				(evt as { toolName?: string }).toolName ??
				"unknown";
			console.log(`[pi] tool call: ${toolName}`);
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
		if (t === "agent_end") resolveTurnEnd?.();
		if (t === "error") {
			const errMsg =
				(evt as { error?: string; message?: string }).error ??
				(evt as { message?: string }).message ??
				"session error";
			rejectTurnEnd?.(new Error(errMsg));
		}
	});

	// Hard timeout per session (không phải per-turn).
	const timeoutHandle = setTimeout(() => {
		const msg = `review session exceeded ${setup.timeoutMs}ms`;
		console.warn(`[pi] ${msg} — aborting session`);
		session.abort().catch(() => void 0);
		rejectTurnEnd?.(new Error(msg));
	}, setup.timeoutMs);

	try {
		for (let turn = 0; turn <= MAX_VERDICT_REMINDS; turn++) {
			// Reset turn-end promise cho turn này
			const turnEnded = new Promise<void>((resolve, reject) => {
				resolveTurnEnd = resolve;
				rejectTurnEnd = reject;
			});

			const promptText =
				turn === 0
					? attempt === 0
						? setup.reviewPrompt
						: setup.reviewPrompt + retryNote(attempt)
					: buildVerdictReminder(toolState);

			console.log(
				`[pi] attempt ${attempt + 1}/${MAX_SESSION_RETRIES} turn ${turn + 1} — ${turn === 0 ? "review" : "verdict remind"}`,
			);

			// session.prompt queue input; await turn end (agent_end hoặc error event).
			await session.prompt(promptText);
			await turnEnded;

			// Đã verdict?
			if (toolState.approved || toolState.changesRequested) {
				console.log(
					`[pi] verdict: ${toolState.approved ? "approved" : "changes_requested"} (attempt ${attempt + 1}, turn ${turn + 1})`,
				);
				break;
			}

			// Chưa verdict — nhắc nếu còn budget turn
			if (turn < MAX_VERDICT_REMINDS) {
				console.warn(`[pi] no verdict after turn ${turn + 1} — reminding AI`);
			}
		}
	} catch (err) {
		agentError = err instanceof Error ? err.message : String(err);
		console.warn(`[pi] session attempt ${attempt + 1} error: ${agentError}`);
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

/**
 * Run a review với retry + verdict remind.
 *
 * 2 cơ chế phòng thủ:
 *   1. Session retry (MAX_SESSION_RETRIES): nếu session crash (stream error,
 *      JSON parse, network) → tạo fresh session, review lại từ đầu.
 *   2. Verdict remind (MAX_VERDICT_REMINDS): trong cùng session, nếu AI end turn
 *      mà chưa gọi approve_mr/request_changes → nhắc AI verdict (giữ context).
 *
 * Model resolution:
 *   opts.model (from .pi/config.yaml llm.model) > Pi auto-detect
 *   Format: "provider/model" e.g. "zai/glm-5.2", "openai/gpt-4o".
 *   Empty/undefined → Pi picks first available provider from auth.
 */
export async function runPiReview(opts: {
	ctx: MrContext;
	repoDir: string;
	diffEntries: MergeRequestDiffEntry[];
	/** "provider/model" e.g. "zai/glm-5.2". Override from .pi/config.yaml. */
	model?: string;
	/** Max tool calls (purged từ env — từ cfg.review.limits.maxToolCalls). */
	maxToolCalls?: number;
	/** Review timeout ms per session (purged từ env — từ cfg.review.limits.timeoutMs). */
	timeoutMs?: number;
}): Promise<PiReviewResult> {
	const startedAt = Date.now();
	const modelId = opts.model ?? "";

	// === SETUP (chạy 1 lần, reuse cho mọi attempt) ===

	// Resolve model
	let resolvedModel: ReturnType<typeof getBuiltinModel> | undefined;
	if (modelId) {
		const slashIdx = modelId.indexOf("/");
		if (slashIdx <= 0) {
			return {
				ok: false,
				markdown: "",
				eventCount: 0,
				error: `Invalid model '${modelId}'. Expected format 'provider/model' e.g. 'zai/glm-5.2', 'openai/gpt-4o'.`,
				durationMs: Date.now() - startedAt,
				toolState: createInitialToolState(),
			};
		}
		const provider = modelId.slice(0, slashIdx);
		const model = modelId.slice(slashIdx + 1);
		try {
			resolvedModel = getBuiltinModel(provider as never, model as never);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				markdown: "",
				eventCount: 0,
				error: `Model '${modelId}' not found. Run 'pi --list-models' to see available. Original: ${msg}`,
				durationMs: Date.now() - startedAt,
				toolState: createInitialToolState(),
			};
		}
	}

	await mkdir(PI_AGENT_DIR, { recursive: true });

	const basePrompt = await loadBasePrompt();
	const projectRules = await loadProjectRules(opts.repoDir);
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
		appendSystemPrompt: projectRules ? [projectRules] : [],
	});
	await resourceLoader.reload();

	const setup: SessionSetup = {
		reviewPrompt: buildPrompt({ ctx: opts.ctx, diffEntries: opts.diffEntries }),
		resolvedModel,
		timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000,
		resourceLoader,
	};

	// === RETRY LOOP ===
	let lastResult: PiReviewResult | undefined;
	let totalEvents = 0;

	for (let attempt = 0; attempt < MAX_SESSION_RETRIES; attempt++) {
		const result = await runSessionAttempt(setup, opts, attempt);
		lastResult = result;
		totalEvents += result.eventCount;

		const verdict =
			result.toolState.approved || result.toolState.changesRequested;
		if (result.ok && verdict) {
			// Success — return với total event count + total duration
			return {
				...result,
				eventCount: totalEvents,
				durationMs: Date.now() - startedAt,
			};
		}

		if (attempt < MAX_SESSION_RETRIES - 1) {
			const reason = result.ok
				? "no verdict after reminds"
				: `error: ${result.error}`;
			console.warn(
				`[pi] attempt ${attempt + 1}/${MAX_SESSION_RETRIES} failed (${reason}) — retrying with fresh session`,
			);
		}
	}

	// All attempts exhausted — inconclusive (no verdict) hoặc error
	return {
		...lastResult!,
		eventCount: totalEvents,
		durationMs: Date.now() - startedAt,
	};
}
