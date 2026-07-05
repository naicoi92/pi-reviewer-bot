/**
 * Per-project config schema.
 *
 * Loaded from `<repo>/.pi/config.yaml` (optional). All fields have
 * sensible defaults — if the file is missing the bot still works with the
 * hard-coded defaults below.
 */

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

export interface ReviewConfig {
  /** Comment language: `vi` | `en`. */
  language: "vi" | "en";
  /** Regex matched against MR title — if matches, skip review. */
  skipTitleRegex: string;
  /** Regex matched against source branch — if matches, skip review. */
  skipBranchRegex: string;
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

export interface CiConfig {
  /**
   * When true, bot waits for CI pipeline to pass before reviewing.
   * - MR webhook đến + CI running → enqueue pending, đợi pipeline webhook.
   * - Pipeline webhook `status=success` → trigger deferred review.
   * - CI fail → skip review + post note.
   *
   * Requires GitLab project to enable "Pipeline events" webhook (ngoài MR events).
   * Default: false (review ngay khi MR webhook đến — backward compatible).
   */
  require: boolean;
  /**
   * Timeout đợi CI (ms). Nếu CI chạy lâu hơn, bot proceed review anyway + log.
   * Default: lấy từ env `CI_WAIT_TIMEOUT_MS` (server-wide, default 600000 = 10 phút).
   * Override per-project tại đây (vd E2E chậm → 1_800_000 = 30 phút).
   * `undefined` → resolve at runtime qua env fallback chain.
   */
  waitTimeoutMs?: number;
}

export interface ProjectConfig {
  review: ReviewConfig;
  scope: ScopeConfig;
  llm: LlmConfig;
  block: BlockConfig;
  ci: CiConfig;
}

export const DEFAULT_CONFIG: ProjectConfig = {
  review: {
    language: "vi",
    // JS-compatible: NO inline (?i) flag (PCRE-only). Use case-insensitive
    // match at construction time — see webhook.ts which builds with `new RegExp(pattern)`.
    // To match "WIP" case-insensitively we use a character class.
    skipTitleRegex: "\\b(wip|WIP|Wip|dnr|DNR|do not review|Do Not Review)\\b",
    skipBranchRegex: "^(wip|scratch)/.*",
  },
  scope: {
    enabled: false,
  },
  llm: {},
  // Default: blocking OFF. Project must opt-in via .pi/config.yaml
  // AND set up the Approval Rule in GitLab project settings.
  block: { enabled: false },
  // Default: CI wait OFF. Project opt-in via .pi/config.yaml.
  // Khi bật, project phải enable thêm "Pipeline events" webhook trên GitLab
  // (ngoài "Merge request events") để bot nhận được signal CI finish.
  ci: { require: false },
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
    if (r.language === "vi" || r.language === "en") cfg.review.language = r.language;
    if (typeof r.skipTitleRegex === "string") cfg.review.skipTitleRegex = r.skipTitleRegex;
    if (typeof r.skipBranchRegex === "string") cfg.review.skipBranchRegex = r.skipBranchRegex;
  }

  if (u.scope && typeof u.scope === "object") {
    const s = u.scope as Record<string, unknown>;
    if (typeof s.enabled === "boolean") cfg.scope.enabled = s.enabled;
    if (typeof s.convention === "string") cfg.scope.convention = s.convention;
    if (typeof s.resolvesPattern === "string") cfg.scope.resolvesPattern = s.resolvesPattern;
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

  if (u.ci && typeof u.ci === "object") {
    const c = u.ci as Record<string, unknown>;
    if (typeof c.require === "boolean") cfg.ci.require = c.require;
    // Validate waitTimeoutMs: phải là số nguyên dương. Reject NaN/âm/float.
    if (typeof c.waitTimeoutMs === "number" && Number.isFinite(c.waitTimeoutMs) && c.waitTimeoutMs > 0) {
      cfg.ci.waitTimeoutMs = Math.floor(c.waitTimeoutMs);
    }
  }

  return cfg;
}
