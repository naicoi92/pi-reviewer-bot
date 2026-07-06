# Design: webhook-to-ci-job

> Technical approach đảo D1. Đọc kèm: `proposal.md` + `specs/review-job/spec.md`.
> Principle: port `performReview` sang `MrContext`-entry, strip webhook/ciwait/inflight/
> limiter/clone, đổi entry HTTP→CLI. **Config-vs-Env**: `.pi/config.yaml` chứa mọi config
> (purge operational knobs khỏi env), env = secrets + CI runtime CHỈ. `gitlab.ts` +
> `ssrf.ts` + 11 tools giữ nguyên; `pi.ts` + `tools/index.ts` sửa nhỏ (đọc từ config).

## 1. Data flow (post-change)

```
GitLab CI job (merge_request_event, needs: [test, build])
  │  runner checkout source branch → process.cwd()
  ▼
src/index.ts (CLI entry)
  ├─ mrContextFromEnv()          → MrContext      [src/context.ts NEW]
  ├─ loadConfig(process.cwd())   → ProjectConfig   [src/config.ts, drop ci.*]
  ├─ warn WEBHOOK_SECRET legacy  (log, không fail)
  ├─ performReview(ctx, cfg)     → ReviewOutcome    [src/review.ts NEW, port]
  │     ├─ unapproveMr(ctx)      nếu block.enabled     [src/gitlab.ts, giữ]
  │     ├─ fetchMrDiff(ctx)                            [src/gitlab.ts, giữ]
  │     ├─ runPiReview(ctx, cfg, repoDir)              [src/pi.ts, giữ]
  │     └─ derive outcome từ toolState
  ├─ emitStatsLine(ctx, outcome)   stdout JSON        [src/stats.ts, đổi sink]
  └─ process.exit(outcome.ok ? 0 : 1)
```

## 2. Module layout

| File | Action | Ghi chú |
|---|---|---|
| `src/webhook.ts` | **XÓA** | performReview port sang review.ts; còn lại verifyToken/shouldReview/checkCiAndWait/resolveCiWaitTimeoutMs — toàn bộ webhook-only |
| `src/ciwait.ts` | **XÓA** | D10 obsolete |
| `src/inflight.ts` | **XÓA** | D11/D12 obsolete |
| `src/limiter.ts` | **XÓA** | 1 review/job, không concurrent |
| `src/types.ts` | **SỬA** | Xóa `MergeRequestWebhook`, `Pipeline`, payload webhook. Giữ `MrContext` (dùng bởi gitlab.ts/pi.ts/review.ts) |
| `src/index.ts` | **REWRITE** | Hono server → CLI entry (section 6) |
| `src/context.ts` | **MỚI** | `mrContextFromEnv()` (section 4) |
| `src/review.ts` | **MỚI** | `performReview(ctx, cfg)` port (section 5) |
| `src/repo.ts` | **SỬA** | Xóa `cloneForReview`, export `repoDir`. Giữ `readFileOrNull` (section 7) |
| `src/config.ts` | **SỬA** | Xóa `CiConfig` + field `ci?` + handling trong `mergeConfig` (section 8) |
| `src/stats.ts` | **SỬA** | Bỏ HTTP `/stats`, emit 1 JSON line/review (section 9) |
| `src/gitlab.ts` | GIỮ | nguyên vẹn |
| `src/pi.ts` | **SỬA (nhỏ)** | Đọc model/timeout từ `cfg.llm.model` + `cfg.review.limits` thay vì `process.env.DEFAULT_MODEL`/`REVIEW_TIMEOUT_MS`. Xóa 2 module-level env const (section 3.3) |
| `src/tools/index.ts` | **SỬA (nhỏ)** | `MAX_TOOL_CALLS` đọc từ `cfg.review.limits.maxToolCalls` (qua tool state) thay vì `process.env` |
| `src/ssrf.ts` | GIỮ | nguyên vẹn |
| `src/tools/*` (11 còn lại) | GIỮ | nguyên vẹn |
| `templates/review.gitlab-ci.yml` | **MỚI** | section 10 |
| `docs/CI_SETUP.md` | **MỚI** | onboard guide |
| `Dockerfile` | **SỬA** | bỏ EXPOSE + healthcheck (section 10) |
| `package.json` | **SỬA** | bỏ dep `hono` (nếu không dùng chỗ khác); bump major |

## 3. Key contracts

### 3.1 `mrContextFromEnv(): MrContext` (src/context.ts)

Đọc CI predefined env, throw `ContextError` nếu thiếu required var. Không fallback SHA.

```ts
type MrContext = {
  projectId: string;      // CI_PROJECT_ID
  mrIid: string;          // CI_MERGE_REQUEST_IID
  projectPath: string;    // CI_PROJECT_PATH
  projectUrl: string;     // CI_PROJECT_URL
  sourceSha: string;      // CI_MERGE_REQUEST_SOURCE_BRANCH_SHA
  targetBranch: string;   // CI_MERGE_REQUEST_TARGET_BRANCH_NAME
  apiBase: string;        // CI_API_V4_URL
  token: string;          // GITLAB_TOKEN
};
function mrContextFromEnv(env = process.env): MrContext { ... }
```

Inject `env` param để test mock. Required vars check đầu, throw `ContextError(name)`
với message rõ. `apiBase` có sẵn dạng `https://gitlab.com/api/v4`.

**Auth guard**: `GITLAB_TOKEN` MUST là Project Access Token hoặc user PAT (scope `api`,
role approver) — KHÔNG phải `CI_JOB_TOKEN`. `CI_JOB_TOKEN` chỉ đọc được MR endpoints,
không POST approve/note được. `index.ts` check `process.env.GITLAB_TOKEN === process.env.CI_JOB_TOKEN`
→ warn + exit 1 (fail fast).

### 3.2 `ReviewOutcome` + exit-code map (src/review.ts)

```ts
type ReviewOutcome =
  | { ok: true; verdict: "approved" | "changes_requested" }
  | { ok: false; reason: "inconclusive" | "error"; detail?: string };
```

| Outcome | exit | MR |
|---|---|---|
| approved | 0 | unblocked (bot approved) |
| changes_requested | 0 | blocked (bot request_changes — intentional) |
| inconclusive | 1 | blocked |
| error (LLM/network/timeout/exception) | 1 | blocked |

Job pass (`exit 0`) = review chạy xong có verdict rõ, BẤT KỂ approve hay block.
Job fail (`exit 1`) = bot lỗi/inconclusive → MR giữ blocked, user re-run. Spec req 3.

### 3.3 Config schema + Config-vs-Env boundary

**Nguyên lý**: `.pi/config.yaml` = mọi config (declarative, versioned với repo). Env =
secrets + CI runtime context CHỈ. Operational knobs PURGE khỏi env → config.yaml.

`.pi/config.yaml` schema (sau change):

```yaml
review:
  language: vi
  skipTitleRegex: "\\b(wip|dnr|do not review)\\b"
  skipBranchRegex: "^(wip|scratch)/.*"
  limits:                    # MỚI (purge từ env)
    maxToolCalls: 30         # từng MAX_TOOL_CALLS_PER_REVIEW
    timeoutMs: 300000        # từng REVIEW_TIMEOUT_MS (5 min)
scope: { enabled, convention, resolvesPattern, taskIndex }
llm:
  model: zai/glm-5.2         # model source duy nhất (DEFAULT_MODEL env purge)
block: { enabled }
# ci.* — XÓA (D10 obsolete)
```

| Nơi | Chứa gì |
|---|---|
| `.pi/config.yaml` | `review.*` (language/skip/limits), `scope.*`, `llm.model`, `block.*` |
| env (GitLab CI var) — secrets | `GITLAB_TOKEN`, LLM keys (`ZAI_API_KEY`...), `EXA_API_KEY` |
| env (GitLab CI predefined) — runtime | `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA`, ... |

**PURGE khỏi env** (chuyển sang config.yaml): `DEFAULT_MODEL`, `MAX_TOOL_CALLS_PER_REVIEW`,
`REVIEW_TIMEOUT_MS`. Model resolution mới: `cfg.llm.model` (config.yaml) > Pi auto-detect
(first provider có key). Không còn deployment-wide env default.

`ProjectConfig` bỏ `ci?: CiConfig`. `ReviewLimits` interface mới (`maxToolCalls`, `timeoutMs`),
default `{ 30, 300000 }`. Gặp `ci.*` legacy → ignore + `console.warn` (spec req 6).
`runPiReview` nhận `cfg.review.limits.timeoutMs` + `cfg.llm.model` qua opts (đã nhận opts.model).
Tool factory nhận `cfg.review.limits.maxToolCalls` qua shared state → `MAX_TOOL_CALLS`.

## 4. `src/context.ts` design

```ts
export class ContextError extends Error { constructor(public varName: string) {...} }
export function mrContextFromEnv(env = process.env): MrContext {
  const required = ["CI_PROJECT_ID","CI_MERGE_REQUEST_IID","CI_PROJECT_PATH",
    "CI_PROJECT_URL","CI_MERGE_REQUEST_SOURCE_BRANCH_SHA",
    "CI_MERGE_REQUEST_TARGET_BRANCH_NAME","CI_API_V4_URL","GITLAB_TOKEN"] as const;
  for (const k of required) if (!env[k]) throw new ContextError(k);
  return { /* map */ };
}
```

`repoDir` resolve: `env.LOCAL_REPO_PATH ?? process.cwd()` (local debug, spec req 8).

## 5. `performReview` port (src/review.ts)

Port từ `webhook.ts:143-316`, thay đổi:

- **Signature**: `performReview(ctx: MrContext, cfg: ProjectConfig): Promise<ReviewOutcome>`
  (thay vì `(payload, opts)`).
- **Bỏ**: `resolveCiWaitTimeoutMs` + `checkCiAndWait` (ciwait), `withLimits` (limiter),
  `cloneForReview` → dùng `repoDir` từ context.ts, payload-derived ctx logic.
- **Giữ**: unapprove-if-block, fetchMrDiff, runPiReview, derive outcome, postMrNote
  (review failed / inconclusive notes).
- **Log prefix** giữ `[review !${ctx.mrIid}]`.
- Wrap toàn bộ try/catch → trả `{ok:false, reason:"error", detail}` thay vì rethrow
  (caller index.ts map exit code). Giữ note "🤖 Review failed" cho user.

Logic derive outcome từ toolState giữ nguyên (approve_mr / request_changes / inconclusive).

## 6. `src/index.ts` → CLI

```ts
import { mrContextFromEnv, ContextError } from "./context.ts";
import { performReview } from "./review.ts";
import { loadConfig } from "./config.ts";
import { emitStatsLine } from "./stats.ts";

async function main() {
    if (process.env.WEBHOOK_SECRET) console.warn("WEBHOOK_SECRET still set — webhook mode removed, delete it");
    if (process.env.GITLAB_TOKEN && process.env.GITLAB_TOKEN === process.env.CI_JOB_TOKEN) {
      console.error("GITLAB_TOKEN === CI_JOB_TOKEN — job token cannot approve MRs or post notes. Use a Project Access Token or user PAT (scope api, role approver).");
      process.exit(1);
    }
    let ctx, cfg;
  try { ctx = mrContextFromEnv(); } catch (e) { console.error(e.message); process.exit(1); }
  cfg = loadConfig(process.cwd());
  const t0 = Date.now();
  const outcome = await performReview(ctx, cfg);
  emitStatsLine(ctx, outcome, Date.now() - t0);
  process.exit(outcome.ok ? 0 : 1);
}
main();
```

Bỏ: Hono app, `POST /webhook`, `GET /healthz`, `GET /stats`, `verifyToken`,
`shouldReview`, PORT binding.

## 7. `src/repo.ts` simplify

- Xóa: `cloneForReview`, `shortSha`, `ClonedRepo` interface.
- Export: `export const repoDir = process.env.LOCAL_REPO_PATH ?? process.cwd();`
- Giữ: `readFileOrNull(dir, relPath)` nguyên vẹn (fetch_file tool dùng).
- `src/tools/fetch_file.ts` đổi `cloneForReview` → dùng `repoDir` import (section 5 callers).

## 8. `src/config.ts` changes

- Xóa `CiConfig` interface (48-66).
- `ProjectConfig` (68-74) bỏ field `ci?: CiConfig`, thêm `review.limits?: ReviewLimits`.
- Thêm `ReviewLimits` interface: `{ maxToolCalls: number; timeoutMs: number }`,
  default `{ 30, 300000 }`.
- `ReviewConfig` thêm field `limits?: ReviewLimits`.
- `mergeConfig` (102-143):
  - Bỏ parse `ci.*`; gặp `user.ci` → `console.warn`.
  - Parse `user.review.limits`: validate `maxToolCalls` (số nguyên >0), `timeoutMs`
    (số nguyên >0). Reject NaN/âm/float.

## 9. `src/stats.ts` changes

- Bỏ HTTP `/stats` handler (chuyển ra index.ts đã xóa).
- Thêm `emitStatsLine(ctx, outcome, durationMs)`: `console.log(JSON.stringify({
  project, mrIid, sourceSha, outcome: outcome.verdict ?? outcome.reason,
  durationMs, timestamp }))`.
- Giữ counter logic nếu còn dùng internal — review, giữ minimal.

## 10. Template CI + Dockerfile

### `templates/review.gitlab-ci.yml`

```yaml
pi-review:
  stage: review
  image:
    name: ghcr.io/<org>/pi-reviewer-bot:latest
    entrypoint: [""]
  needs:
    - job: test
    - job: build
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_STRATEGY: none
  script:
    - /app/pi-reviewer-bot
```

### Dockerfile delta

- Bỏ `EXPOSE 3000`, bỏ `HEALTHCHECK`.
- Giữ multi-stage Bun `--compile` builder + Alpine runtime.
- Entrypoint: binary `/app/pi-reviewer-bot` (đã là default, không cần CMD server).

## 11. Tests

| File | Scope |
|---|---|
| `test/context.test.ts` (MỚI) | `mrContextFromEnv`: đầy đủ env → ok; thiếu từng var → throw `ContextError`; repoDir LOCAL_REPO_PATH fallback |
| `test/review.test.ts` (REWRITE từ webhook.test.ts) | `performReview`: approve→ok:0, request_changes→ok:0, inconclusive→fail, exception→fail (mock gitlab/pi) |
| `test/config.test.ts` (MỚI nếu chưa có) | `mergeConfig`: ci.* ignored + warn; review/scope/block/llm parse đúng |
| `test/tools.test.ts` | GIỮ (registration không đổi) |
| `test/ssrf.test.ts` | GIỮ |

Strict TDD (config.yaml): RED-GREEN-TRIANGULATE-REFACTOR cho context.ts + review.ts.

## 12. Rollout / migration

1. Implement context.ts + review.ts + index.ts (CLI) + repo/config/stats simplify.
2. Xóa webhook.ts/ciwait.ts/inflight.ts/limiter.ts + types webhook parts.
3. templates/review.gitlab-ci.yml + docs/CI_SETUP.md.
4. Dockerfile delta + package.json (bump major, drop hono).
5. README + AGENTS.md (Decision Log: D1-revised, D10/D11/D12/D14 obsolete).
6. `bun test` + `bun run typecheck` pass.
7. Dogfood: pi-reviewer-bot review chính nó qua CI job.

## 13. Decisions & alternatives

| Quyết định | Alternatives đã loại | Lý do |
|---|---|---|
| Port `performReview` sang `MrContext`-entry | (a) Viết lại từ đầu (b) Wrapper gọi payload→ctx | Port giữ logic outcome proven; chỉ đổi entry + strip. Nhỏ diff nhất |
| `ReviewOutcome` discriminated union | String/enum return | Type-safe exit-code map, không parse |
| `repoDir = process.cwd()` const | Giữ `cloneForReview` no-op | Ít code, đúng ý CI checkout sẵn |
| `emitStatsLine` stdout JSON | (a) Xóa stats.ts (b) Giữ HTTP | CI log = consumer, 1 dòng JSON parse được, không丢 observability |
| `LOCAL_REPO_PATH ?? cwd()` | CLI flag `--repo` | Env var khớp convention CI/local, ít surface |
| Bump major + drop hono | Giữ hono dep "phòng khi" | YAGNI, dead dep = bloat |
| Purge operational knobs (DEFAULT_MODEL/MAX_TOOL_CALLS/REVIEW_TIMEOUT) → config.yaml | (a) Giữ knobs ở env deployment-wide (b) Hybrid: knobs env, model config.yaml | Nguyên lý user: config → config.yaml, env = secrets+runtime. Thuần nhất, per-project tunable. Mất deployment-wide default (chấp nhận) |

### Risks mang sang tasks phase

- Diff ước tính > 400 dòng (xóa 5 file ~600 + rewrite + mới ~400) → **Review Workload
  Guard** sẽ check sau sdd-tasks, có thể đề xuất chained PR (CLI core trước, xóa
  webhook sau).
- `MrContext` shape phải khớp `gitlab.ts`/`pi.ts` existing → verify khi port (không
  đổi signature consumer).
