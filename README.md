# pi-reviewer-bot

[![Build](https://github.com/naicoi92/pi-reviewer-bot/actions/workflows/build.yml/badge.svg)](https://github.com/naicoi92/pi-reviewer-bot/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Alpine%20%7E115MB-blue)](https://github.com/naicoi92/pi-reviewer-bot/pkgs/container/pi-reviewer-bot)

**AI code review bot cho GitLab** — webhook service nhận MR events, dùng [Pi Coding Agent SDK](https://pi.dev) để review, và tự approve/request_changes qua tool calls.

Bot hỗ trợ **bất kỳ LLM provider nào** Pi hỗ trợ (40+): Z.ai GLM, OpenAI GPT, Anthropic Claude, DeepSeek, Google Gemini, Bedrock, Vertex, Ollama... Bạn chỉ cần set API key của provider muốn dùng.

## Kiến trúc — Mức 3 Full Tool

AI reviewer có **10 tools** và tự decide approve/request_changes qua tool call (không parse verdict regex):

| Nhóm | Tools |
|---|---|
| **Read context** | `fetch_file`, `get_issue`, `list_mr_comments`, `list_mr_commits`, `list_wiki_pages`, `get_wiki_page` |
| **Write verdict** | `post_inline_comment`, `post_summary`, `approve_mr`, `request_changes` |

Guardrail: `approve_mr` block nếu chưa `post_summary` hoặc còn critical unresolved.

## Quick Start

```bash
# 1. Pull image (~115MB, multi-arch amd64+arm64)
docker pull ghcr.io/naicoi92/pi-reviewer-bot:latest

# 2. Configure
cp .env.example .env
# Edit .env: WEBHOOK_SECRET, GITLAB_API_TOKEN, và 1 LLM API key (vd ZAI_API_KEY)

# 3. Run
docker compose up -d

# 4. Add webhook trong GitLab project:
#    URL: https://your-host/webhook
#    Secret: <WEBHOOK_SECRET từ .env>
#    Trigger: ✅ Merge request events
```

Xong. Mở MR → bot review trong ~30s-3 phút.

📖 **Full setup**: [docs/SETUP.md](docs/SETUP.md)
📖 **Integrate vào project khác**: [docs/INTEGRATION.md](docs/INTEGRATION.md)

## Tính năng

- ✅ **Multi-provider** — Z.ai / OpenAI / Anthropic / DeepSeek / Gemini / Ollama / bất kỳ Pi provider nào
- ✅ **10 tools** — AI có tools để fetch context, post inline comments, approve, request changes
- ✅ **Inline line comments** — DiffNote qua GitLab Discussions API với position hash
- ✅ **Merge gate** — block MR cho đến khi bot approve (`block.enabled: true` + GitLab Approval Rule)
- ✅ **Multi-project** — 1 bot instance phục vụ mọi GitLab project qua `.pi/config.yaml`
- ✅ **Per-project config** — mỗi project customize language, scope rules, model
- ✅ **Concurrency + rate limit** — global semaphore + per-project cooldown
- ✅ **`/stats` endpoint** — observability per-project
- ✅ **Guardrail chống hallucinate approve** — phải post_summary trước + 0 critical unresolved
- ✅ **Fail-safe** — bot unapprove nếu AI crash trước khi gọi verdict tool

## Cấu trúc repo

```
pi-reviewer-bot/
├── Dockerfile                  # Multi-stage: Bun --compile + Alpine runtime (~115MB)
├── docker-compose.yml          # Production deploy convenience
├── package.json                # Bun project deps
├── agents/
│   └── code-reviewer.md        # System prompt cho AI reviewer (10 tools)
├── src/
│   ├── index.ts                # Hono app: POST /webhook, GET /healthz, /stats
│   ├── webhook.ts              # Verify token + filter + orchestrate review
│   ├── gitlab.ts               # GitLab API client (approve, comment, get_issue, ...)
│   ├── repo.ts                 # Shallow clone source branch per-MR
│   ├── pi.ts                   # Pi SDK wrapper — createAgentSession + subscribe
│   ├── config.ts               # .pi/config.yaml loader
│   ├── stats.ts                # Per-project observability
│   ├── limiter.ts              # Semaphore + rate limit
│   ├── types.ts                # Webhook payload types
│   └── tools/                  # 10 custom tools (defineTool)
│       ├── index.ts            # Tool factory + shared state
│       ├── result.ts           # AgentToolResult helpers (ok/err/done)
│       ├── fetch_file.ts       # Read file (path traversal guard)
│       ├── get_issue.ts        # GitLab issue + comments + linked MRs
│       ├── list_mr_comments.ts # Existing comments (idempotent re-review)
│       ├── list_mr_commits.ts  # Commit history
│       ├── list_wiki_pages.ts  # Wiki slug discovery
│       ├── get_wiki_page.ts    # Read wiki page
│       ├── post_summary.ts     # Top-level verdict (required before approve)
│       ├── post_inline_comment.ts  # DiffNote với severity + line validation
│       ├── approve_mr.ts       # Approve (guardrail: summary + 0 critical)
│       └── request_changes.ts  # Unapprove (block merge)
├── test/
│   └── webhook.test.ts         # 22 unit tests
└── docs/
    ├── SETUP.md                # Deploy guide (Docker, K8s, systemd)
    ├── INTEGRATION.md          # Setup bot cho project khác (cho AI consumer)
    ├── CONFIG.md               # .pi/config.yaml schema
    ├── ARCHITECTURE.md         # Design + decision log
    └── MULTIPROJECT.md         # Multi-project operations
```

## LLM Providers

Bot dùng [Pi Coding Agent SDK](https://pi.dev) → tự động hỗ trợ 40+ providers. Set API key env var của provider bạn muốn dùng:

| Provider | Env var | Cost |
|---|---|---|
| **Z.ai** (recommend) | `ZAI_API_KEY` | $12.6/mo flat (Coding Plan) |
| OpenAI | `OPENAI_API_KEY` | Pay-as-you-go |
| Anthropic | `ANTHROPIC_API_KEY` | Pay-as-you-go |
| DeepSeek | `DEEPSEEK_API_KEY` | Pay-as-you-go (rẻ nhất) |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | Free tier + paid |
| AWS Bedrock | AWS credentials | Pay-as-you-go |
| Ollama (local) | (không cần key) | Free |

Set `DEFAULT_MODEL=provider/model` trong `.env` hoặc để trống để Pi auto-detect.

Full list: `pi --list-models` hoặc https://pi.dev/models

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | [Bun](https://bun.sh) 1.1+ (compiled standalone binary) |
| HTTP framework | [Hono](https://hono.dev) |
| GitLab API | [@gitbeaker/rest](https://gitlab.com/gitlab-org/gitbeaker/) |
| AI agent | [Pi Coding Agent](https://pi.dev) SDK (in-process, custom tools) |
| LLM | Bất kỳ Pi provider (Z.ai GLM, OpenAI, Anthropic, ...) |
| Image | Alpine (~115MB, multi-arch amd64+arm64) |

## Develop

```bash
bun install
cp .env.example .env  # điền ZAI_API_KEY hoặc provider khác
bun run dev            # hot reload tại localhost:3000

bun test               # 22 tests
bun run typecheck      # strict TypeScript
```

Xem [CONTRIBUTING.md](CONTRIBUTING.md) để đóng góp.

## License

[MIT](LICENSE) © 2026 Nai Coi
