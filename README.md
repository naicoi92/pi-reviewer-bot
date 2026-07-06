# pi-reviewer-bot

[![Build](https://github.com/naicoi92/pi-reviewer-bot/actions/workflows/build.yml/badge.svg)](https://github.com/naicoi92/pi-reviewer-bot/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://github.com/naicoi92/pi-reviewer-bot/pkgs/container/pi-reviewer-bot)](https://github.com/naicoi92/pi-reviewer-bot/pkgs/container/pi-reviewer-bot)

**AI code review bot cho GitLab** — chạy như một **GitLab CI job** cuối pipeline,
dùng [Pi Coding Agent SDK](https://pi.dev) review diff, tự approve/request_changes
qua tool calls. Không còn webhook server (D1-revised).

Multi-provider (40+): Z.ai GLM, OpenAI, Anthropic, DeepSeek, Gemini, Ollama...

> 📖 **[Hướng dẫn sử dụng đầy đủ](docs/USAGE.md)** — setup, config, luồng làm việc,
> troubleshooting, migration. Bắt đầu từ đó.

## Documentation

| Doc | Purpose |
|---|---|
| **[📖 Hướng dẫn sử dụng đầy đủ](docs/USAGE.md)** | Setup → config → daily workflow → troubleshooting → migrate (bắt đầu ở đây) |
| **[📖 CI Setup](docs/CI_SETUP.md)** | Token (tier-aware) + merge gate + CI variables + include template |
| **[📖 Config Schema](docs/CONFIG.md)** | `.pi/config.yaml` full reference |
| **[📖 Architecture](docs/ARCHITECTURE.md)** | Design + decision log (D1-D17) |

---

## 🚀 Quickstart (tóm tắt)

**Project side** (xem [USAGE](docs/USAGE.md) chi tiết):

1. **Token**: Personal Access Token (Free) hoặc Project Access Token (Premium+) — scope `api`, role Developer. (CI_JOB_TOKEN không dùng được.)
2. **Merge gate**: Settings → Repository → Protected branches → “Pipelines must succeed” (mọi tier — pi-review exit 1 blocks merge).
3. **CI/CD Variables**: `GITLAB_API_TOKEN` + `ZAI_API_KEY` (masked).
4. **Include template** trong `.gitlab-ci.yml`:

   ```yaml
   # Option A: Component (preferred, cần GitLab catalog project)
   include:
     - component: $CI_SERVER_FQDN/<org>/pi-reviewer-bot/review@~1.0
       inputs: { needs: [test, build] }
   # Option B: Raw (GitHub-hosted, chạy ngay)
   # include:
   #   - remote: '<github-raw-url>/templates/review.gitlab-ci.yml'
   ```

5. **(Optional) `.pi/config.yaml`**: `block: { enabled: true }`, `llm: { model: zai/glm-5.2 }`.

Mở MR → pipeline chạy → `pi-review` job review → bot comment + approve/request_changes.

> ⚠️ `CI_JOB_TOKEN` **không dùng được** (chỉ đọc MR) — phải là Personal Access Token (Free) / Project Access Token (Premium+).

---

## Kiến trúc — Mức 3 Full Tool

AI reviewer có **12 tools**, tự decide approve/request_changes (không parse verdict):

| Nhóm | Tools |
|---|---|
| **Read** | `fetch_file`, `get_issue`, `list_mr_comments`, `list_mr_commits`, `list_wiki_pages`, `get_wiki_page` |
| **Web lookup** | `web_search`, `fetch_url` — tra version/API/CVE (SSRF guard) |
| **Write** | `post_inline_comment`, `post_summary`, `approve_mr`, `request_changes` |

Guardrail: `approve_mr` block nếu chưa `post_summary` hoặc còn critical unresolved.

## Exit-code contract

| Outcome | exit | MR |
|---|---|---|
| approved / changes_requested | 0 | unblocked / blocked (intentional, job pass) |
| inconclusive / error | 1 | blocked (user re-run pipeline) |

Job fail = bot lỗi → MR blocked (safe default). Xem [USAGE §7](docs/USAGE.md).

## Tính năng

- ✅ **Multi-provider** — Z.ai/OpenAI/Anthropic/DeepSeek/Gemini/Ollama
- ✅ **12 tools** — fetch context, web search, inline comments, approve/changes
- ✅ **CI native wait** — job đặt cuối pipeline (`needs:`), không state in-memory
- ✅ **Merge gate** — block MR đến khi bot approve
- ✅ **Per-project config** — `.pi/config.yaml` (review/scope/block/llm/limits)
- ✅ **Guardrail** — phải post_summary + 0 critical trước approve
- ✅ **CI Component** — versioned, `inputs` (stage/needs/image), hoặc raw include

## LLM Providers

Set API key (CI/CD Variable) của provider muốn dùng — Pi auto-detect:

| Provider | Env var | Cost |
|---|---|---|
| **Z.ai** (recommend) | `ZAI_API_KEY` | $12.6/mo flat |
| OpenAI | `OPENAI_API_KEY` | pay-as-you-go |
| Anthropic | `ANTHROPIC_API_KEY` | pay-as-you-go |
| DeepSeek | `DEEPSEEK_API_KEY` | rẻ nhất |
| Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | free tier + paid |
| Ollama (local) | — | free |

Model: `llm.model` (`.pi/config.yaml`) > Pi auto-detect. List: `pi --list-models`.

## Cấu trúc repo

```
pi-reviewer-bot/
├── src/
│   ├── index.ts            # CLI entrypoint (exit-code contract)
│   ├── context.ts          # mrContextFromEnv (CI predefined vars)
│   ├── review.ts           # performReview + deriveOutcome + shouldSkip
│   ├── gitlab.ts           # GitLab API client
│   ├── pi.ts               # Pi SDK wrapper
│   ├── config.ts           # .pi/config.yaml loader + mergeConfig
│   ├── repo.ts stats.ts ssrf.ts types.ts
│   └── tools/              # 12 tools
├── templates/
│   ├── review.yml          # CI Component (spec.inputs)
│   └── review.gitlab-ci.yml # Raw include fallback
├── agents/                 # BOT-OWNED system prompt
├── docs/                   # USAGE, CI_SETUP, CONFIG, ARCHITECTURE
├── Dockerfile              # Bun --compile + Alpine (no EXPOSE)
└── package.json            # 1.0.0, no hono
```

## Develop

```bash
bun install
bun test               # 52 tests
bun run typecheck      # strict TS

# Local debug (mock CI env): xem docs/USAGE.md §3.6
```

## License

[MIT](LICENSE) © 2026 Nai Coi
