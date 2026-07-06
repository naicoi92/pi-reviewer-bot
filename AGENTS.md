# AGENTS.md — pi-reviewer-bot

> Tài liệu này được Pi Coding Agent (và các AI agent khác như Codex, Cursor) đọc
> tự động khi làm việc trong repo. Giữ ngắn gọn, factual, update khi architecture đổi.

## Project Overview

**pi-reviewer-bot** — Webhook bot service nhận GitLab Merge Request events →
spawn AI code review qua **Pi Coding Agent SDK** → post comments + approve/request_changes.

- **Stack**: Bun 1.1+ runtime (compiled standalone), Hono HTTP framework, Pi SDK in-process
- **Architecture**: Mức 3 full tool — AI có 10 tools để tự decide approve
- **LLM**: Multi-provider (Z.ai, OpenAI, Anthropic, DeepSeek, Gemini, Ollama, ...) qua Pi SDK
- **Hosting**: Docker container (Alpine runtime, multi-arch amd64+arm64), chạy bất cứ đâu
- **License**: MIT

## Repo Layout (flat — không có subdirectories vô nghĩa)

```
pi-reviewer-bot/
├── AGENTS.md                       # file này — Pi auto-load
├── README.md                       # overview + quick start
├── Dockerfile                      # Multi-stage: Bun --compile + Alpine, ~115MB
├── docker-compose.yml              # dev/test convenience
├── package.json                    # deps: @earendil-works/pi-coding-agent, @gitbeaker/rest, yaml (no hono — CLI mode)
├── templates/
│   ├── review.yml                 # CI Component (spec.inputs: stage/needs/image)
│   └── review.gitlab-ci.yml       # Raw include fallback (GitHub-hosted)
├── tsconfig.json                   # strict mode
├── agents/
│   ├── code-reviewer.md            # BOT-OWNED system prompt (load runtime, KHÔNG copy sang project)
│   └── REVIEW_RULES.template.md    # template optional cho .pi/REVIEW_RULES.md (project-owned)
├── src/
│   ├── index.ts                    # CLI entrypoint (CI-job mode, exit-code contract)
│   ├── context.ts                  # mrContextFromEnv() — đọc GitLab CI predefined vars
│   ├── review.ts                   # performReview orchestration + deriveOutcome
│   ├── gitlab.ts                   # GitLab API client (approve, comment, get_issue, ...)
│   ├── repo.ts                     # repoDir (process.cwd) + readFileOrNull
│   ├── pi.ts                       # Pi SDK wrapper — createAgentSession + subscribe
│   ├── config.ts                   # .pi/config.yaml loader + mergeConfig (drop ci.*, add limits)
│   ├── stats.ts                    # emitStatsLine (stdout JSON)
│   ├── ssrf.ts                     # SSRF guard cho fetch_url (block private IP + non-http protocols)
│   ├── types.ts                    # MR data types (webhook payload types removed)
│   └── tools/                      # 12 custom tools (defineTool)
│       ├── index.ts                # tool factory + shared state
│       ├── result.ts               # ok/err/done helpers (AgentToolResult shape)
│       ├── fetch_file.ts           # read file (path traversal guard)
│       ├── get_issue.ts            # GitLab issue + comments + linked MRs
│       ├── list_mr_comments.ts     # existing comments (idempotent re-review)
│       ├── list_mr_commits.ts      # commit history
│       ├── list_wiki_pages.ts      # wiki slug discovery
│       ├── get_wiki_page.ts        # read wiki page (ADRs ngoài repo)
│       ├── web_search.ts           # search internet (Exa hoặc DuckDuckGo) — dep/API/CVE verify
│       ├── fetch_url.ts            # read URL content (Bun fetch + SSRF guard)
│       ├── post_summary.ts         # top-level verdict (BẮT BUỘC trước approve)
│       ├── post_inline_comment.ts  # DiffNote với severity + line validation
│       ├── approve_mr.ts           # approve (guardrail: summary + 0 critical)
│       └── request_changes.ts      # unapprove (block merge)
└── test/
    ├── context.test.ts             # mrContextFromEnv tests
    ├── config.test.ts              # config schema (limits, ci.* removed)
    ├── review.test.ts              # deriveOutcome (exit-code contract)
    ├── ssrf.test.ts                # SSRF guard tests
    └── tools.test.ts               # tool registration tests
```

## 12 Tools (Mức 3 Full Tool)

AI reviewer có 12 tools (chia 2 nhóm):

### Read (không mutate state)

1. `fetch_file(path)` — đọc file verify context
2. `get_issue(iid)` — GitLab issue gốc + comments + linked MRs
3. `list_mr_comments()` — existing comments (idempotent re-review)
4. `list_mr_commits()` — commit history
5. `list_wiki_pages()` — wiki slug discovery
6. `get_wiki_page(slug)` — read wiki page
7. `web_search(query, maxResults?)` — search internet (dep version, API, CVE)
8. `fetch_url(url)` — read URL content (sau web_search hoặc URL đã biết)

### Write (mutate state + call GitLab API)

1. `post_inline_comment(path, line, comment, severity)` — DiffNote line-specific
2. `post_summary(markdown)` — top-level verdict (BẮT BUỘC trước approve)
3. `approve_mr(rationale)` — approve (guardrail: summary + 0 critical)
4. `request_changes(reason)` — unapprove (block merge)

**Guardrail approve_mr**: block nếu chưa post_summary HOẶC criticalCount > 0.

### Web Lookup — trigger-driven

`web_search` + `fetch_url` cho phép AI verify dependency version mới nhất, API
deprecation, CVE. **Default ON** (luôn available, không cần per-project opt-in).
AI tự decide khi nào dùng dựa trên trigger trong system prompt (xem
`agents/code-reviewer.md` "Web Lookup — Khi nào dùng"):

- ✅ Trigger: version mismatch, outdated dep, API deprecated/sai signature, CVE concern
- ❌ Skip: pure logic, style, obvious bugs, diff nhỏ
- Budget: hard cap 5 web calls/review
- Bun native `fetch()` (HTTP/2 auto), SSRF guard block private IP literals

Optional `EXA_API_KEY` env để dùng Exa search (quality cao cho code docs); nếu
không set → fallback DuckDuckGo (free, no key).

## LLM Providers (Multi-provider)

Bot dùng Pi Coding Agent SDK → hỗ trợ 40+ providers. KHÔNG hardcode 1 provider:

| Provider | Env var | Notes |
|---|---|---|
| Z.ai GLM | `ZAI_API_KEY` | Default recommend, $12.6/mo flat |
| OpenAI | `OPENAI_API_KEY` | GPT-4o, o1, ... |
| Anthropic | `ANTHROPIC_API_KEY` | Claude 3.5 Sonnet, Opus, ... |
| DeepSeek | `DEEPSEEK_API_KEY` | Rẻ nhất |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | |
| Ollama | (không cần key) | Local, free |

Model resolution priority:

1. `.pi/config.yaml` → `llm.model` (per-project override)
2. `DEFAULT_MODEL` env var (deployment-wide)
3. Pi auto-detect (provider đầu tiên có API key)

Set `DEFAULT_MODEL=` (empty) để Pi auto-pick. Hoặc explicit `DEFAULT_MODEL=provider/model`.

## Critical Conventions

### TypeScript

- **strict mode** (`tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- Typecheck: `bun run typecheck` (must pass before commit)
- ESM only (`"type": "module"`)
- No `any` — dùng `unknown` + type guard

### Naming

- File: `snake_case.ts` (vd `post_inline_comment.ts`)
- Function: `camelCase` (vd `mrContextFromWebhook`)
- Type/Interface: `PascalCase` (vd `MrContext`, `ReviewToolState`)
- Const enum-like: `UPPER_SNAKE_CASE` (vd `MAX_TOOL_CALLS`)

### Comments

- Viết tiếng Việt cho business logic
- Code identifier giữ tiếng Anh
- JSDoc cho mọi public function (export)

### Tests

- File: `*.test.ts` trong `test/` folder
- Framework: `bun:test` (built-in)
- Run: `bun test`
- Mỗi fix bug PHẢI có test case regression

## Workflow

```bash
# Dev
bun install
cp .env.example .env  # điền giá trị
bun run dev           # hot reload

# Test
bun test
bun run typecheck

# Build image
docker build -t pi-reviewer-bot:latest .

# Run
docker run --rm -p 3000:3000 --env-file .env pi-reviewer-bot:latest

# Healthcheck
curl http://localhost:3000/healthz
```

## Per-project Config

Project nào muốn AI review tạo file `.pi/config.yaml` trong repo:

```yaml
review:
  language: vi
  skipTitleRegex: "\\b(wip|dnr|do not review)\\b"
  skipBranchRegex: "^(wip|scratch)/.*"

scope:
  enabled: true                    # bật scope alignment check
  convention: "feat/T-XX-*"
  resolvesPattern: "Resolves: #(\\d+)"
  taskIndex: docs/design/07-roadmap.md

block:
  enabled: true                    # block merge cho đến khi bot approve

# ci.* — ĐÃ LOẠI BỎ (D1-revised). CI native lo wait qua `needs:`.
# review.limits (purge từ env DEFAULT_MODEL/MAX_TOOL_CALLS_PER_REVIEW/REVIEW_TIMEOUT_MS):

llm:
  model: zai/glm-5.2               # model source duy nhất (DEFAULT_MODEL env đã purge)
```

Xem [`docs/CONFIG.md`](docs/CONFIG.md) cho schema đầy đủ.

## Decision Log

| # | Quyết định | Lý do |
|---|---|---|
| D1 | ~~Webhook service~~ **OBSOLETE — reversed by D17** | Multi-project scale (webhook-era) |
| D2 | Pi SDK in-process (không subprocess) | No cold start, type-safe, custom tools native |
| D3 | Mức 3 full tool (AI có approve_mr) | Clean intent, không parse verdict regex |
| D4 | Top-level note + DiffNote inline | MVP đầy đủ cho 95% use case |
| D5 | Docker Alpine cả builder lẫn runtime | Image ~115MB, đồng bộ musl, có shell debug |
| D6 | Semaphore 3 + 10s cooldown/project | Chống OOM + infinite loop |
| D7 | Approval gate qua GitLab API | Block merge, auto-reset on push |
| D8 | Multi-provider (không hardcode Z.ai) | Pi SDK hỗ trợ 40+ providers, user tự chọn |
| D9 | Flatten repo (không bot/ subdir) | Đơn giản, source là project chính |
| D10 | CI wait qua pipeline webhook + stateful Map in-memory | Event-driven (không polling), không giữ slot semaphore khi chờ, per-project timeout override |
| D11 | Cancel review cũ qua AbortController khi push mới | Tránh 2 review song song (race condition, duplicate comment, sai SHA diff) |
| D12 | Unapprove đồng bộ khi push mới + block=true | Đóng merge window — approval cũ (cho SHA trước) bị revoke ngay, MR blocked trong suốt re-review |
| D13 | Web lookup (web_search + fetch_url) — default ON, prompt-driven triggers | Verify dep version mới nhất, API deprecation, CVE. AI tự decide dựa trên trigger trong system prompt (không per-project opt-in). Bun native fetch (HTTP/2), SSRF guard cơ bản. Exa nếu có key, fallback DuckDuckGo. |
| D14 | `mrContextFromWebhook` fallback SHA consistent với `ciwait.ts` + `inflight.ts` (fix BUG 5) | Trước đây 3 chỗ resolve SHA khác nhau → `getMrPipelineStatus` filter theo SHA undefined → lấy tất cả pipelines (kể cả zombie cũ running) → CI wait mode stuck. Fix:统 nhất `source_branch_sha ?? last_commit.id` + log warn khi vẫn undefined (fallback newest pipeline). |
| D15 | Pipeline webhook handler log mọi skip path (fix BUG 6) | 3 skip path silent khiến debug "pipeline webhook có đến bot không" vô hiệu. Log `[webhook] pipeline skip <project>@<short-sha> — <reason>` consistent với MR webhook skip log. |
| D16 | Tách system prompt: bot-controlled base + project append qua `.pi/REVIEW_RULES.md` | Bot owned phần "how to use tools / workflow" — project không copy. Project chỉ viết info về project của họ. Bot upgrade tools → project auto kế thừa. Dùng `appendSystemPrompt` của Pi SDK DefaultResourceLoader. Backwards compat: `.pi/agents/code-reviewer.md` legacy vẫn đọc + warn. |
| D17 | **Webhook service → GitLab CI job (reverse D1)** | ciwait in-memory Map mất khi restart, SHA matching BUG 5 (3 sites khác nhau), bot online 24/7, inflight cancel phức tạp. CI native `needs:` + predefined env vars giải tất cả. Hard cutover + major bump. Config: purge env knobs (`DEFAULT_MODEL`/`MAX_TOOL_CALLS_PER_REVIEW`/`REVIEW_TIMEOUT_MS`) → `.pi/config.yaml` (`review.limits`, `llm.model`). Token = Project Access Token (không `CI_JOB_TOKEN`). |
| D18 | `sourceSha`/`targetSha` resolve qua fallback (reverse D14/D17 strictness) | `CI_MERGE_REQUEST_*_BRANCH_SHA` empty trong detached/merged-result pipelines (known GitLab bug, xác nhận via `CI_MERGE_REQUEST_EVENT_TYPE=detached`). Resolve: `sourceSha = CI_MERGE_REQUEST_SOURCE_BRANCH_SHA ?? CI_COMMIT_SHA`; `targetSha = CI_MERGE_REQUEST_TARGET_BRANCH_SHA ?? CI_MERGE_REQUEST_DIFF_BASE_SHA`. `CI_COMMIT_SHA` thêm vào REQUIRED_ENV. Side benefit: DIFF_BASE_SHA (merge base) là `base_sha`/`start_sha` đúng hơn cho DiffNote position so với target HEAD. |
| D19 | Retry session + verdict remind trong `pi.ts` (2 cơ chế phòng thủ verdict) | BUG: AI burn budget vào web_search/tool calls, end turn mà chưa gọi `approve_mr`/`request_changes` → `outcome=inconclusive` → job FAIL → user re-run pipeline (MR !15: 8312 events, 4 web_search, 215s, no verdict). Giải pháp: (1) **Session retry** `MAX_SESSION_RETRIES=2` — session crash (stream error, JSON parse, network) → fresh session, review lại. (2) **Verdict remind** `MAX_VERDICT_REMINDS=2` — cùng session, AI end turn chưa verdict → nhắc (giữ context, rẻ ~5s vs retry ~3min). `buildVerdictReminder(state)` include state (summaryPosted, criticalCount) → AI biết bước tiếp. Refactor `runPiReview`: setup once → retry loop → `runSessionAttempt` (remind loop). Loại text-parse verdict (lùi D3) — giữ tool-based. |

Xem [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) cho decision chi tiết.

**OBSOLETE (D1-revised đảo sang CI-job mode):** D6 (limiter), D10 (ciwait),
D11 (inflight cancel), D12 (unapprove-on-push), D14 (SHA unify), D15 (pipeline
webhook skip log). CI native (`needs:` + predefined env vars) thay thế toàn bộ.

## Known Limitations (post-MVP)

- ❌ Multi-tenant GitLab token (hiện 1 PAT cho mọi project)
- ❌ Slash command runtime (`@pi-bot rebase`)
- ❌ Web UI dashboard
- ❌ OpenTelemetry export
- ❌ Auto-fix commits
- ❌ Pending CI wait mất khi bot restart (in-memory, không persist — user push commit retry)
- ❌ Parent-child pipelines (downstream, `trigger:` keyword) không tracked — bot chỉ check parent pipeline status. Workaround: dùng `needs:` trong CI config để parent đợi child xong
- ❌ Web tools SSRF chỉ check IP literal — không resolve DNS (DNS-rebind bypass possible). Acceptable risk cho code-review bot.
- ❌ Web tools không render JS (no headless browser) — SPA docs pages trả HTML trống không đọc được. Workaround: dùng sitemap hoặc trực tiếp MDN/GitHub raw.
- ❌ Web search không cache — mỗi review re-fetch. Post-MVP: Redis/disk cache.

## Useful Commands

```bash
# Format check
bun run typecheck

# Test watch mode
bun test --watch

# Build + run locally để debug
docker build -t pi-reviewer-bot:dev .
docker run --rm -p 3000:3000 --env-file .env -it pi-reviewer-bot:dev sh

# Multi-arch build
docker buildx build --platform linux/amd64,linux/arm64 \
  -t pi-reviewer-bot:latest .

# Inspect final image size
docker images pi-reviewer-bot --format "{{.Size}}"
```
