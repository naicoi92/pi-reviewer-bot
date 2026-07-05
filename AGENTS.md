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
├── package.json                    # deps: @earendil-works/pi-coding-agent, hono, @gitbeaker/rest, yaml
├── tsconfig.json                   # strict mode
├── agents/
│   └── code-reviewer.md            # system prompt cho AI reviewer (10 tools)
├── src/
│   ├── index.ts                    # Hono app entrypoint (POST /webhook, GET /healthz, /stats)
│   ├── webhook.ts                  # verify token + filter + orchestrate review
│   ├── gitlab.ts                   # GitLab API client (approve, comment, get_issue, ...)
│   ├── repo.ts                     # shallow clone source branch per-MR
│   ├── pi.ts                       # Pi SDK wrapper — createAgentSession + subscribe
│   ├── config.ts                   # .pi/config.yaml loader + defaults
│   ├── stats.ts                    # per-project observability
│   ├── limiter.ts                  # semaphore + rate limit
│   ├── types.ts                    # webhook payload + types
│   └── tools/                      # 10 custom tools (defineTool)
│       ├── index.ts                # tool factory + shared state
│       ├── result.ts               # ok/err/done helpers (AgentToolResult shape)
│       ├── fetch_file.ts           # read file (path traversal guard)
│       ├── get_issue.ts            # GitLab issue + comments + linked MRs
│       ├── list_mr_comments.ts     # existing comments (idempotent re-review)
│       ├── list_mr_commits.ts      # commit history
│       ├── list_wiki_pages.ts      # wiki slug discovery
│       ├── get_wiki_page.ts        # read wiki page (ADRs ngoài repo)
│       ├── post_summary.ts         # top-level verdict (BẮT BUỘC trước approve)
│       ├── post_inline_comment.ts  # DiffNote với severity + line validation
│       ├── approve_mr.ts           # approve (guardrail: summary + 0 critical)
│       └── request_changes.ts      # unapprove (block merge)
└── test/
    └── webhook.test.ts             # 22 unit tests
```

## 10 Tools (Mức 3 Full Tool)

AI reviewer có 10 tools (chia 2 nhóm):

### Read (không mutate state)
1. `fetch_file(path)` — đọc file verify context
2. `get_issue(iid)` — GitLab issue gốc + comments + linked MRs
3. `list_mr_comments()` — existing comments (idempotent re-review)
4. `list_mr_commits()` — commit history
5. `list_wiki_pages()` — wiki slug discovery
6. `get_wiki_page(slug)` — read wiki page

### Write (mutate state + call GitLab API)
7. `post_inline_comment(path, line, comment, severity)` — DiffNote line-specific
8. `post_summary(markdown)` — top-level verdict (BẮT BUỘC trước approve)
9. `approve_mr(rationale)` — approve (guardrail: summary + 0 critical)
10. `request_changes(reason)` — unapprove (block merge)

**Guardrail approve_mr**: block nếu chưa post_summary HOẶC criticalCount > 0.

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

llm:
  model: zai/glm-5.2               # override default (có thể dùng openai/gpt-4o, ...)
```

Xem [`docs/CONFIG.md`](docs/CONFIG.md) cho schema đầy đủ.

## Decision Log

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Webhook service (không CI job) | Multi-project scale, central control |
| D2 | Pi SDK in-process (không subprocess) | No cold start, type-safe, custom tools native |
| D3 | Mức 3 full tool (AI có approve_mr) | Clean intent, không parse verdict regex |
| D4 | Top-level note + DiffNote inline | MVP đầy đủ cho 95% use case |
| D5 | Docker Alpine cả builder lẫn runtime | Image ~115MB, đồng bộ musl, có shell debug |
| D6 | Semaphore 3 + 10s cooldown/project | Chống OOM + infinite loop |
| D7 | Approval gate qua GitLab API | Block merge, auto-reset on push |
| D8 | Multi-provider (không hardcode Z.ai) | Pi SDK hỗ trợ 40+ providers, user tự chọn |
| D9 | Flatten repo (không bot/ subdir) | Đơn giản, source là project chính |

Xem [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) cho decision chi tiết.

## Known Limitations (post-MVP)

- ❌ Multi-tenant GitLab token (hiện 1 PAT cho mọi project)
- ❌ Slash command runtime (`@pi-bot rebase`)
- ❌ Web UI dashboard
- ❌ OpenTelemetry export
- ❌ Auto-fix commits

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
