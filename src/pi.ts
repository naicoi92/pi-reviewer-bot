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

/**
 * Run a review with Pi SDK in-process.
 *
 * Model resolution:
 *   opts.model (from .pi/config.yaml llm.model) > Pi auto-detect
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
	/** Max tool calls (purged từ env — từ cfg.review.limits.maxToolCalls). */
	maxToolCalls?: number;
	/** Review timeout ms (purged từ env — từ cfg.review.limits.timeoutMs). */
	timeoutMs?: number;
}): Promise<PiReviewResult> {
	const startedAt = Date.now();
	const modelId = opts.model ?? ""; // empty → Pi auto-pick from auth

	// Tool state — shared across all tools in this review
	const toolState = createInitialToolState();
	const toolCtx = {
		mrContext: opts.ctx,
		repoDir: opts.repoDir,
		diffEntries: opts.diffEntries,
		state: toolState,
		maxToolCalls: opts.maxToolCalls ?? 30,
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
		noTools: "all", // disable built-in read/bash/edit/write
		tools: toolNames, // expose custom tools (critical — without this AI sees no tools)
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

	// Build ResourceLoader thủ công để inject base prompt + project rules.
	// DefaultResourceLoader tự discovery .pi/SYSTEM.md nếu ta không pass systemPrompt —
	// ta override để đảm bảo prompt gốc do bot control (project không copy tools guidance).
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

	// Create session
	const { session } = await createAgentSession(
		sessionOpts as Parameters<typeof createAgentSession>[0],
	);

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
		if (t === "agent_end") {
			resolveAgentEnd();
		}
	});

	// Hard timeout — kills session AND rejects prompt() promise.
	const reviewTimeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
	const timeoutHandle = setTimeout(() => {
		const msg = `review exceeded ${reviewTimeoutMs}ms`;
		console.warn(`[pi] ${msg} — aborting session`);
		session.abort().catch(() => void 0);
		rejectAgentEnd(new Error(msg));
	}, reviewTimeoutMs);

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
