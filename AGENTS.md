# AGENTS.md — pi-reviewer-bot

> Tài liệu này được Pi Coding Agent (và các AI agent khác như Codex, Cursor) đọc
> tự động khi làm việc trong repo. Giữ ngắn gọn, factual, update khi architecture đổi.

## Project Overview

**pi-reviewer-bot** — Webhook bot service nhận GitLab Merge Request events →
spawn AI code review qua **Pi Coding Agent SDK** + **Z.ai GLM-5.2** →
post comments + approve/request_changes.

- **Stack**: Bun 1.1+ runtime, Hono HTTP framework, Pi Coding Agent SDK in-process
- **Architecture**: Mức 3 full tool — AI có 10 tools để tự decide approve
- **LLM**: Z.ai Coding Plan (`zai/glm-5.2`, 1M context, $12.6/mo flat)
- **Hosting**: Docker container (Alpine runtime, multi-arch), chạy bất cứ đâu
- **License**: MIT

## Repo Layout

```
pi-reviewer-bot/
├── AGENTS.md                       # file này — Pi auto-load
├── README.md                       # overview + quick start
├── Dockerfile                      # CI image (cho .gitlab-ci.yml)
├── docker-compose.yml              # dev/test convenience
├── .env.example                    # tất cả env vars
├── .dockerignore
│
├── bot/
│   ├── Dockerfile                  # bot image (Bun --compile, alpine builder + runtime, ~115MB)
│   ├── package.json                # deps: @earendil-works/pi-coding-agent, hono, @gitbeaker/rest, yaml
│   ├── tsconfig.json               # strict mode
│   ├── agents/
│   │   └── code-reviewer.md        # system prompt cho AI reviewer (10 tools)
│   ├── src/
│   │   ├── index.ts                # Hono app entrypoint (POST /webhook, GET /healthz, /stats)
│   │   ├── webhook.ts              # verify token + filter + orchestrate review
│   │   ├── gitlab.ts               # GitLab API client (approve, comment, get_issue, ...)
│   │   ├── repo.ts                 # shallow clone source branch per-MR
│   │   ├── pi.ts                   # Pi SDK wrapper — createAgentSession + subscribe
│   │   ├── config.ts               # .pi/config.yaml loader + defaults
│   │   ├── stats.ts                # per-project observability
│   │   ├── limiter.ts              # semaphore + rate limit
│   │   ├── types.ts                # webhook payload + types
│   │   └── tools/                  # 10 custom tools (defineTool)
│   │       ├── index.ts            # tool factory + shared state
│   │       ├── result.ts           # ok/err/done helpers (AgentToolResult shape)
│   │       ├── fetch_file.ts       # read file (path traversal guard)
│   │       ├── get_issue.ts        # GitLab issue + comments + linked MRs
│   │       ├── list_mr_comments.ts # existing comments (idempotent re-review)
│   │       ├── list_mr_commits.ts  # commit history
│   │       ├── list_wiki_pages.ts  # wiki slug discovery
│   │       ├── get_wiki_page.ts    # read wiki page (ADRs ngoài repo)
│   │       ├── post_summary.ts     # top-level verdict (BẮT BUỘC trước approve)
│   │       ├── post_inline_comment.ts  # DiffNote với severity + line validation
│   │       ├── approve_mr.ts       # approve (guardrail: summary + 0 critical)
│   │       └── request_changes.ts  # unapprove (block merge)
│   └── test/
│       └── webhook.test.ts         # 22 unit tests
│
└── docs/
    ├── SETUP.md                    # deploy guide (Docker, K8s, systemd)
    ├── CONFIG.md                   # .pi/config.yaml schema
    ├── ARCHITECTURE.md             # design + decision log
    └── MULTIPROJECT.md             # multi-project ops
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
- File: `*.test.ts` cùng folder với source (hoặc `test/` cho integration)
- Framework: `bun:test` (built-in)
- Run: `bun test`
- Mỗi fix bug PHẢI có test case regression

## LLM Provider

- **Default**: `zai/glm-5.2` (Z.ai Coding Plan, $12.6/mo)
- **Env var**: `ZAI_API_KEY` (Pi auto-detect)
- **Per-project override**: `.pi/config.yaml` → `llm.model`
- Pi providers list: `pi --list-models`

## Workflow

```bash
# Dev
cd bot
bun install
cp ../.env.example ../.env  # điền giá trị
bun run dev                   # hot reload

# Test
bun test
bun run typecheck

# Build image (từ repo root)
docker build -t pi-reviewer-bot:latest -f bot/Dockerfile .

# Run
docker run --rm -p 3000:3000 --env-file .env pi-reviewer-bot:latest

# Healthcheck
curl http://localhost:3000/healthz
```

## Setup Guide (đầy đủ)

Xem [`docs/SETUP.md`](docs/SETUP.md). Tóm tắt:

1. **Build image**: `docker build -t pi-reviewer-bot:latest -f bot/Dockerfile .`
2. **Set 3 env vars**: `WEBHOOK_SECRET`, `GITLAB_API_TOKEN`, `ZAI_API_KEY`
3. **Run container**: docker run / docker compose up / kubectl apply
4. **Add webhook** trong GitLab project: URL `http://<host>:3000/webhook`, secret, trigger MR events

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
  model: zai/glm-5.2               # override default
```

Xem [`docs/CONFIG.md`](docs/CONFIG.md) cho schema đầy đủ.

## Decision Log

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Webhook service (không CI job) | Multi-project scale, central control |
| D2 | Pi SDK in-process (không subprocess) | No cold start, type-safe, custom tools native |
| D3 | Mức 3 full tool (AI có approve_mr) | Clean intent, không parse verdict regex |
| D4 | Top-level note + DiffNote inline | MVP đầy đủ cho 95% use case |
| D5 | Alpine cả builder lẫn runtime + Bun --compile | Image ~115MB, đồng bộ musl, có shell debug |
| D6 | Semaphore 3 + 10s cooldown/project | Chống OOM + infinite loop |
| D7 | Approval gate qua GitLab API | Block merge, auto-reset on push |
| D8 | Z.ai Coding Plan native | 1 env var `ZAI_API_KEY`, không config thủ công |

Xem [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) cho decision chi tiết.

## Known Limitations (post-MVP)

- ❌ Multi-tenant GitLab token (hiện 1 PAT cho mọi project)
- ❌ Slash command runtime (`@pi-bot rebase`)
- ❌ Web UI dashboard
- ❌ OpenTelemetry export
- ❌ Auto-fix commits

## Useful Commands

```bash
# Format check (chưa setup prettier — dùng manual)
bun run typecheck

# Test watch mode
bun test --watch

# Build + run locally để debug
docker build -t pi-reviewer-bot:dev -f bot/Dockerfile .
docker run --rm -p 3000:3000 --env-file .env -it pi-reviewer-bot:dev sh

# Multi-arch build
docker buildx build --platform linux/amd64,linux/arm64 \
  -t pi-reviewer-bot:latest -f bot/Dockerfile .

# Inspect final image size
docker images pi-reviewer-bot --format "{{.Size}}"
```
