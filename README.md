# pi-reviewer-bot

[![Build](https://github.com/naicoi92/pi-reviewer-bot/actions/workflows/build.yml/badge.svg)](https://github.com/naicoi92/pi-reviewer-bot/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Alpine%20%7E115MB-blue)](https://github.com/naicoi92/pi-reviewer-bot/pkgs/container/pi-reviewer-bot)

**AI code review bot cho GitLab** — webhook service nhận MR events, dùng [Pi Coding Agent SDK](https://pi.dev) để review, và tự approve/request_changes qua tool calls.

Bot hỗ trợ **bất kỳ LLM provider nào** Pi hỗ trợ (40+): Z.ai GLM, OpenAI GPT, Anthropic Claude, DeepSeek, Google Gemini, Bedrock, Vertex, Ollama... Bạn chỉ cần set API key của provider muốn dùng.

## Documentation

| Doc | Audience | Purpose |
|---|---|---|
| **[📖 Deploy Guide](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/SETUP.md)** | Dev ops / SRE | Build image, run container (Docker/K8s/systemd), expose webhook |
| **[📖 Integration Guide](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/INTEGRATION.md)** | AI agent / project owner | Setup bot cho project GitLab của bạn (`.pi/config.yaml`, agent prompt, webhook) |
| **[📖 Skills](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/SKILLS.md)** | Developer / AI agent ở project đã setup bot | Luồng công việc hàng ngày với bot: tạo MR, đợi review, đọc comment, xử lý feedback, re-trigger khi cần |
| **[📖 Config Schema](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/CONFIG.md)** | Project owner | `.pi/config.yaml` full schema + examples |
| **[📖 Architecture](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/ARCHITECTURE.md)** | Maintainer | Design decisions, decision log (D1-D11) |
| **[📖 Multi-project Ops](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/MULTIPROJECT.md)** | Ops | Vận hành bot cho nhiều project |

---

## 🚀 Deploy bot (cho dev ops)

Bot chạy dạng Docker container. 3 bước:

### Bước 1 — Pull hoặc build image

```bash
# Pull từ GHCR (recommend)
docker pull ghcr.io/naicoi92/pi-reviewer-bot:latest

# Hoặc build từ source
git clone https://github.com/naicoi92/pi-reviewer-bot.git
cd pi-reviewer-bot
docker build -t pi-reviewer-bot:latest .
```

### Bước 2 — Configure env

```bash
cp .env.example .env
```

Edit `.env`, set 3 biến bắt buộc:

```bash
WEBHOOK_SECRET=$(openssl rand -hex 16)        # random, dùng cho GitLab webhook
GITLAB_API_TOKEN=glpat-xxxxxxxxxxxxxxxx        # bot PAT, scope: api
ZAI_API_KEY=zai-xxxxxxxx                       # hoặc OPENAI_API_KEY/ANTHROPIC_API_KEY/...
```

Set thêm `DEFAULT_MODEL=provider/model` nếu muốn lock provider cụ thể. Bỏ trống → Pi auto-detect.

### Bước 3 — Run + expose webhook URL

```bash
# Docker Compose (recommend production)
docker compose up -d

# Hoặc Docker run
docker run -d --name pi-reviewer-bot -p 3000:3000 --env-file .env \
  -v pi-reviews-cache:/tmp/pi-reviews pi-reviewer-bot:latest
```

Expose public URL để GitLab gọi webhook:
- **VPS có public IP**: Caddy/Nginx reverse proxy → `https://pi-bot.yourdomain.com`
- **VPS không public IP**: Cloudflare Tunnel → free HTTPS
- **Local dev**: localtunnel / ngrok

📖 **Chi tiết đầy đủ**: [docs/SETUP.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/SETUP.md) — gồm K8s manifest, systemd unit, troubleshooting.

---

## 🤝 Use bot cho project của bạn (cho project owner)

Sau khi bot deploy, mỗi project GitLab muốn AI review chỉ cần **3 bước**:

### Bước 1 — Tạo `.pi/config.yaml` trong repo project

```yaml
# .pi/config.yaml (optional — bot có default hợp lý)
review:
  language: vi                              # ngôn ngữ comment

scope:
  enabled: true                             # bật scope alignment check
  convention: "feat/T-XX-*"                 # branch pattern → task ID
  resolvesPattern: "Resolves: #(\\d+)"      # MR description → issue
  taskIndex: docs/design/07-roadmap.md      # file tra cứu task

block:
  enabled: true                             # block merge cho đến khi bot approve

# ci:
#   require: true                           # bật nếu muốn bot đợi CI pass mới review
#   waitTimeoutMs: 900000                   # timeout per-project (default = env CI_WAIT_TIMEOUT_MS)

llm:
  model: zai/glm-5.2                        # override (mặc định = bot DEFAULT_MODEL)
```

### Bước 2 — Copy agent prompt (tùy chọn, để customize review rules)

```bash
mkdir -p .pi/agents
# Copy từ template + tùy chỉnh theo project của bạn
curl -o .pi/agents/code-reviewer.md \
  https://raw.githubusercontent.com/naicoi92/pi-reviewer-bot/main/agents/code-reviewer.md
```

Sửa prompt để thêm:
- Stack & conventions của project (vd Rust strict, no `unwrap()`)
- Review focus theo layer (vd domain layer không dùng infra deps)
- Project-specific rules (vd LGPL license, no GPL crate)

### Bước 3 — Add GitLab webhook

```
Project → Settings → Webhook
  URL: https://pi-bot.yourdomain.com/webhook
  Secret token: <WEBHOOK_SECRET>      ← cùng giá trị set trong bot .env
  Trigger: ✅ Merge request events
           ✅ Pipeline events          ← CHỈ khi dùng ci.require: true
```

**Xong.** Mở MR → bot auto-review trong ~30s-3 phút.

📖 **Chi tiết đầy đủ**: [docs/INTEGRATION.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/INTEGRATION.md) — gồm template cho solo dev, monorepo, docs-only project, troubleshooting.

---

## Kiến trúc — Mức 3 Full Tool

AI reviewer có **10 tools** và tự decide approve/request_changes qua tool call (không parse verdict regex):

| Nhóm | Tools |
|---|---|
| **Read context** | `fetch_file`, `get_issue`, `list_mr_comments`, `list_mr_commits`, `list_wiki_pages`, `get_wiki_page` |
| **Write verdict** | `post_inline_comment`, `post_summary`, `approve_mr`, `request_changes` |

Guardrail: `approve_mr` block nếu chưa `post_summary` hoặc còn critical unresolved.

## Tính năng

- ✅ **Multi-provider** — Z.ai / OpenAI / Anthropic / DeepSeek / Gemini / Ollama / bất kỳ Pi provider nào
- ✅ **10 tools** — AI có tools để fetch context, post inline comments, approve, request changes
- ✅ **Inline line comments** — DiffNote qua GitLab Discussions API với position hash
- ✅ **Merge gate** — block MR cho đến khi bot approve (`block.enabled: true` + GitLab Approval Rule)
- ✅ **CI wait mode** — bot đợi CI pass mới review (`ci.require: true` + GitLab Pipeline events webhook) — tiết kiệm token, tránh review code mà CI sẽ catch lỗi
- ✅ **Multi-project** — 1 bot instance phục vụ mọi GitLab project qua `.pi/config.yaml`
- ✅ **Per-project config** — mỗi project customize language, scope rules, model, CI wait timeout
- ✅ **Concurrency + rate limit** — global semaphore + per-project cooldown
- ✅ **`/stats` endpoint** — observability per-project + CI wait pending count
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
│   ├── gitlab.ts               # GitLab API client (approve, comment, get_issue, pipeline status, ...)
│   ├── repo.ts                 # Shallow clone source branch per-MR
│   ├── pi.ts                   # Pi SDK wrapper — createAgentSession + subscribe
│   ├── config.ts               # .pi/config.yaml loader
│   ├── ciwait.ts               # CI wait coordinator (pending Map between MR + pipeline webhooks)
│   ├── inflight.ts             # In-flight review coordinator (cancel old review on new push)
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
