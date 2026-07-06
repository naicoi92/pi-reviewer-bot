/**
 * Per-project config schema.
 *
 * Loaded from `<repo>/.pi/config.yaml` (optional). All fields have
 * sensible defaults — if the file is missing the bot still works with the
 * hard-coded defaults below.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface ScopeConfig {
	/** Enable Scope Alignment Check (verifies MR resolves a task). */
	enabled: boolean;
	/** Branch pattern → task ID extraction, e.g. `feat/T-XX-*`. */
	convention?: string;
	/** Regex to extract issue number from MR description, e.g. `Resolves: #(\d+)`. */
	resolvesPattern?: string;
	/** Path inside the repo to the task index file (e.g. `docs/design/07-roadmap.md`). */
	taskIndex?: string;
}

/** Review execution limits — purged từ env (MAX_TOOL_CALLS_PER_REVIEW, REVIEW_TIMEOUT_MS). */
export interface ReviewLimits {
	/** Max tool calls AI reviewer được dùng / review (từng MAX_TOOL_CALLS_PER_REVIEW). */
	maxToolCalls: number;
	/** Review timeout ms (từng REVIEW_TIMEOUT_MS). */
	timeoutMs: number;
}

export interface ReviewConfig {
	/** Comment language: `vi` | `en`. */
	language: "vi" | "en";
	/** Regex matched against MR title — if matches, skip review. */
	skipTitleRegex: string;
	/** Regex matched against source branch — if matches, skip review. */
	skipBranchRegex: string;
	/** Review execution limits (purged từ env). */
	limits: ReviewLimits;
}

export interface LlmConfig {
	/** Override the bot default model, e.g. `zai-anthropic/glm-5.2`. */
	model?: string;
}

export interface BlockConfig {
	/**
	 * When true, bot calls GitLab approve/unapprove API based on review verdict.
	 * Pair with GitLab project Approval Rules that require the bot as approver
	 * to actually block merges.
	 *
	 * Verdict → approval mapping:
	 *   APPROVE          → approve
	 *   REQUEST_CHANGES  → unapprove (MR stays blocked)
	 *   COMMENT/UNKNOWN  → unapprove (conservative — user can override)
	 */
	enabled: boolean;
}

export interface ProjectConfig {
	review: ReviewConfig;
	scope: ScopeConfig;
	llm: LlmConfig;
	block: BlockConfig;
}

export const DEFAULT_CONFIG: ProjectConfig = {
	review: {
		language: "vi",
		// JS-compatible: NO inline (?i) flag (PCRE-only). Use case-insensitive
		// match at construction time — see webhook.ts which builds with `new RegExp(pattern)`.
		// To match "WIP" case-insensitively we use a character class.
		skipTitleRegex: "\\b(wip|WIP|Wip|dnr|DNR|do not review|Do Not Review)\\b",
		skipBranchRegex: "^(wip|scratch)/.*",
		limits: { maxToolCalls: 30, timeoutMs: 300_000 },
	},
	scope: {
		enabled: false,
	},
	llm: {},
	// Default: blocking OFF. Project must opt-in via .pi/config.yaml
	// AND set up the Approval Rule in GitLab project settings.
	block: { enabled: false },
};

/**
 * Merge user config on top of defaults. Only known fields are read —
 * anything else is ignored (forward-compatible).
 */
export function mergeConfig(user: unknown): ProjectConfig {
	if (!user || typeof user !== "object") return structuredClone(DEFAULT_CONFIG);
	const u = user as Record<string, unknown>;

	const cfg: ProjectConfig = structuredClone(DEFAULT_CONFIG);

	if (u.review && typeof u.review === "object") {
		const r = u.review as Record<string, unknown>;
		if (r.language === "vi" || r.language === "en")
			cfg.review.language = r.language;
		if (typeof r.skipTitleRegex === "string")
			cfg.review.skipTitleRegex = r.skipTitleRegex;
		if (typeof r.skipBranchRegex === "string")
			cfg.review.skipBranchRegex = r.skipBranchRegex;
		if (r.limits && typeof r.limits === "object") {
			const l = r.limits as Record<string, unknown>;
			// Validate: số nguyên dương. Reject NaN/âm/float → giữ default.
			if (Number.isInteger(l.maxToolCalls) && (l.maxToolCalls as number) > 0) {
				cfg.review.limits.maxToolCalls = l.maxToolCalls as number;
			}
			if (Number.isInteger(l.timeoutMs) && (l.timeoutMs as number) > 0) {
				cfg.review.limits.timeoutMs = l.timeoutMs as number;
			}
		}
	}

	if (u.scope && typeof u.scope === "object") {
		const s = u.scope as Record<string, unknown>;
		if (typeof s.enabled === "boolean") cfg.scope.enabled = s.enabled;
		if (typeof s.convention === "string") cfg.scope.convention = s.convention;
		if (typeof s.resolvesPattern === "string")
			cfg.scope.resolvesPattern = s.resolvesPattern;
		if (typeof s.taskIndex === "string") cfg.scope.taskIndex = s.taskIndex;
	}

	if (u.llm && typeof u.llm === "object") {
		const l = u.llm as Record<string, unknown>;
		if (typeof l.model === "string") cfg.llm.model = l.model;
	}

	if (u.block && typeof u.block === "object") {
		const b = u.block as Record<string, unknown>;
		if (typeof b.enabled === "boolean") cfg.block.enabled = b.enabled;
	}

	// ci.* — ĐÃ LOẠI BỎ (D1-revised: CI native handles wait via `needs:`).
	// Gặp legacy config → ignore + warn (không crash).
	if (u.ci !== undefined) {
		console.warn(
			"[config] `ci.*` no longer used — CI native handles wait. Remove from .pi/config.yaml",
		);
	}

	return cfg;
}

/**
 * Load + merge `.pi/config.yaml` từ dir. Missing/unreadable/parse-error → DEFAULT_CONFIG.
 * CI runner checkout source branch vào cwd → config nằm ở `<cwd>/.pi/config.yaml`.
 */
export async function loadConfig(dir: string): Promise<ProjectConfig> {
	const configPath = join(dir, ".pi", "config.yaml");
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch {
		// Missing file — OK, project dùng default config.
		return structuredClone(DEFAULT_CONFIG);
	}
	try {
		return mergeConfig(parse(raw));
	} catch (err) {
		console.warn(
			`[config] .pi/config.yaml parse failed: ${err instanceof Error ? err.message : err} — using defaults`,
		);
		return structuredClone(DEFAULT_CONFIG);
	}
}
