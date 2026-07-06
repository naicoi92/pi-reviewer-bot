# pi-reviewer-bot

[![Build](https://github.com/naicoi92/pi-reviewer-bot/actions/workflows/build.yml/badge.svg)](https://github.com/naicoi92/pi-reviewer-bot/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://github.com/naicoi92/pi-reviewer-bot/pkgs/container/pi-reviewer-bot)](https://github.com/naicoi92/pi-reviewer-bot/pkgs/container/pi-reviewer-bot)

**AI code review bot cho GitLab** — chạy như một **GitLab CI job** cuối pipeline,
dùng [Pi Coding Agent SDK](https://pi.dev) để review, và tự approve/request_changes
qua tool calls. Không còn webhook server (D1-revised).

Bot hỗ trợ **bất kỳ LLM provider nào** Pi hỗ trợ (40+): Z.ai GLM, OpenAI GPT,
Anthropic Claude, DeepSeek, Google Gemini, Bedrock, Vertex, Ollama... Bạn chỉ cần
set API key của provider muốn dùng.

## Documentation

| Doc | Audience | Purpose |
|---|---|---|
| **[📖 CI Setup Guide](docs/CI_SETUP.md)** | Project owner | PAT + Approval Rule + CI variables + include template |
| **[📖 Config Schema](docs/CONFIG.md)** | Project owner | `.pi/config.yaml` full schema + examples |
| **[📖 Architecture](docs/ARCHITECTURE.md)** | Maintainer | Design decisions, decision log (D1-D16) |
| **[📖 Skills](docs/SKILLS.md)** | Developer ở project đã setup bot | Luồng MR → review → feedback hàng ngày |

---

## 🚀 Use bot cho project của bạn (CI-job mode)

### Bước 1 — Tạo Project Access Token

```
Project → Settings → Access Tokens → pi-reviewer-bot, Role: Developer, Scopes: api
```

> `CI_JOB_TOKEN` KHÔNG dùng được (chỉ đọc MR endpoints). Phải là Project Access
> Token hoặc user PAT.

### Bước 2 — Add bot làm required Approval Rule

```
Project → Settings → Merge requests → Approval rules
  Require bot review, Approvals required: 1, Approvers: @pi-reviewer-bot
```

### Bước 3 — Set CI/CD Variables

```
Project → Settings → CI/CD → Variables
  GITLAB_API_TOKEN = glpat-...        (masked + protected)
  ZAI_API_KEY = zai-...               (hoặc OPENAI_API_KEY/ANTHROPIC_API_KEY/...)
```

### Bước 4 — Include CI template

**Option A (preferred):** CI Component với `inputs` (stage/needs/image), versioned:

```yaml
include:
  - component: $CI_SERVER_FQDN/<gitlab-org>/pi-reviewer-bot/review@~1.0
    inputs:
      needs: [lint, test, build]
```

**Option B (raw, GitHub-hosted):**

```yaml
# .gitlab-ci.yml
include:
  - remote: '<github-raw-url>/templates/review.gitlab-ci.yml'
```

Job `pi-review` chạy ở `stage: review`, `rules: merge_request_event`,
`needs: [test, build]` (CI native đợi pass). Chỉnh `needs:` cho khớp pipeline.

> Component cần GitLab catalog project (bot source ở GitHub). Xem docs/CI_SETUP.md.

📖 **Chi tiết**: [docs/CI_SETUP.md](docs/CI_SETUP.md) — gồm migrate từ webhook,
exit-code contract, troubleshooting.

### Bước 5 — (Optional) Per-project config

```yaml
# .pi/config.yaml
review:
  language: vi
  limits: { maxToolCalls: 30, timeoutMs: 300000 }
block:
  enabled: true
llm:
  model: zai/glm-5.2
```

> `ci.*` đã LOẠI BỎ — CI native lo wait. Env knobs (`DEFAULT_MODEL`,
> `MAX_TOOL_CALLS_PER_REVIEW`, `REVIEW_TIMEOUT_MS`) đã chuyển sang config.yaml.

---

## Kiến trúc — Mức 3 Full Tool

AI reviewer có **12 tools** và tự decide approve/request_changes qua tool call
(không parse verdict regex):

| Nhóm | Tools |
|---|---|
| **Read context** | `fetch_file`, `get_issue`, `list_mr_comments`, `list_mr_commits`, `list_wiki_pages`, `get_wiki_page` |
| **Web lookup** | `web_search`, `fetch_url` — tra cứu version mới nhất, API docs, CVE |
| **Write verdict** | `post_inline_comment`, `post_summary`, `approve_mr`, `request_changes` |

Guardrail: `approve_mr` block nếu chưa `post_summary` hoặc còn critical unresolved.

## Tính năng

- ✅ **Multi-provider** — Z.ai / OpenAI / Anthropic / DeepSeek / Gemini / Ollama / bất kỳ Pi provider
- ✅ **12 tools** — fetch context, search internet, post inline comments, approve, request changes
- ✅ **Inline line comments** — DiffNote qua GitLab Discussions API với position hash
- ✅ **Web lookup** — verify dependency version, API deprecation, CVE (`web_search` + `fetch_url`, SSRF guard)
- ✅ **Merge gate** — block MR cho đến khi bot approve (`block.enabled` + GitLab Approval Rule)
- ✅ **CI native wait** — job đặt cuối pipeline (`needs:`), không state in-memory
- ✅ **Per-project config** — `.pi/config.yaml` (review/scope/block/llm/limits)
- ✅ **Guardrail chống hallucinate approve** — phải post_summary + 0 critical
- ✅ **Fail-safe** — job fail (exit 1) nếu review inconclusive/error → MR blocked, user re-run

## Cấu trúc repo

```
pi-reviewer-bot/
├── Dockerfile                  # Multi-stage: Bun --compile + Alpine (no EXPOSE/healthcheck)
├── package.json                # Bun project deps (no hono)
├── templates/
│   └── review.gitlab-ci.yml    # CI job template (include vào .gitlab-ci.yml)
├── agents/
│   ├── code-reviewer.md        # BOT-OWNED system prompt — load runtime, KHÔNG copy
│   └── REVIEW_RULES.template.md
├── src/
│   ├── index.ts                # CLI entrypoint (CI-job mode, exit-code contract)
│   ├── context.ts              # mrContextFromEnv() — đọc CI predefined vars
│   ├── review.ts               # performReview orchestration + deriveOutcome
│   ├── gitlab.ts               # GitLab API client (approve, comment, get_issue, ...)
│   ├── pi.ts                   # Pi SDK wrapper — createAgentSession + subscribe
│   ├── config.ts               # .pi/config.yaml loader + mergeConfig
│   ├── repo.ts                 # repoDir (process.cwd) + readFileOrNull
│   ├── stats.ts                # emitStatsLine (stdout JSON)
│   ├── ssrf.ts                 # SSRF guard cho fetch_url
│   ├── types.ts                # MR data types (webhook payload types removed)
│   └── tools/                  # 12 custom tools (defineTool)
├── test/
│   ├── context.test.ts         # mrContextFromEnv tests
│   ├── config.test.ts          # config schema (limits, ci.* removed)
│   ├── review.test.ts          # deriveOutcome (exit-code contract)
│   ├── tools.test.ts           # tool registration
│   └── ssrf.test.ts            # SSRF guard
└── docs/
    ├── CI_SETUP.md             # CI-job onboard guide
    ├── CONFIG.md               # .pi/config.yaml schema
    └── ARCHITECTURE.md         # Design + decision log
```

## LLM Providers

Bot dùng [Pi Coding Agent SDK](https://pi.dev) → tự hỗ trợ 40+ providers. Set API
key env var (CI/CD Variable) của provider bạn muốn:

| Provider | Env var | Cost |
|---|---|---|
| **Z.ai** (recommend) | `ZAI_API_KEY` | $12.6/mo flat (Coding Plan) |
| OpenAI | `OPENAI_API_KEY` | Pay-as-you-go |
| Anthropic | `ANTHROPIC_API_KEY` | Pay-as-you-go |
| DeepSeek | `DEEPSEEK_API_KEY` | Pay-as-you-go (rẻ nhất) |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | Free tier + paid |
| Ollama (local) | (không cần key) | Free |

Model resolution: `llm.model` (`.pi/config.yaml`) > Pi auto-detect (first provider
có key). Full list: `pi --list-models` hoặc <https://pi.dev/models>

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | [Bun](https://bun.sh) 1.1+ (compiled standalone binary) |
| Entry | CLI 1-shot (CI job) — không HTTP server |
| GitLab API | [@gitbeaker/rest](https://gitlab.com/gitlab-org/gitbeaker/) |
| AI agent | [Pi Coding Agent](https://pi.dev) SDK (in-process, custom tools) |
| LLM | Bất kỳ Pi provider |
| Image | Alpine (~115MB, multi-arch amd64+arm64) trên GHCR |

## Develop

```bash
bun install
bun test               # unit tests
bun run typecheck      # strict TypeScript

# Local debug (mock CI env vars):
CI_MERGE_REQUEST_IID=42 CI_PROJECT_ID=100 CI_PROJECT_PATH=acme/demo \
  CI_PROJECT_URL=https://gitlab.com/acme/demo \
  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME=feat/x CI_MERGE_REQUEST_TARGET_BRANCH_NAME=main \
  CI_MERGE_REQUEST_SOURCE_BRANCH_SHA=abc123 CI_API_V4_URL=https://gitlab.com/api/v4 \
  GITLAB_API_TOKEN=glpat-... ZAI_API_KEY=zai-... \
  bun src/index.ts
```

## License

[MIT](LICENSE) © 2026 Nai Coi
