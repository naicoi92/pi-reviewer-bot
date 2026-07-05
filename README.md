# pi-reviewer-bot

Docker image + webhook bot service cho **AI code review trên GitLab** với [Pi Coding Agent](https://pi.dev) SDK + [Z.ai GLM Coding Plan](https://z.ai/subscribe) (model GLM-5.2).

**Kiến trúc Mức 3 full tool**: AI nhận 5 tools (fetch_file, post_inline_comment, post_summary, approve_mr, request_changes) và tự decide approve/request_changes qua tool call — không cần parse verdict regex.

Có **2 chế độ** sử dụng — chọn tùy nhu cầu:

| Mode | Khi nào | Files |
|---|---|---|
| **🤖 Webhook Bot** (recommended) | Multi-project, muốn add webhook 1 lần rồi quên | [`bot/`](bot/) |
| **🐳 CI Image** | 1 project, dùng trong `.gitlab-ci.yml` job | [`Dockerfile`](Dockerfile) (root) |

---

## 🤖 Webhook Bot — "GitHub App cho GitLab"

Service nhận GitLab webhook → spawn Pi review → post comment. Project nào muốn AI review chỉ cần add webhook 1 lần.

**Deploy với Docker (chạy bất cứ đâu):**

```bash
cd bot
fly launch --no-deploy
fly secrets set WEBHOOK_SECRET=$(openssl rand -hex 16)
fly secrets set GITLAB_API_TOKEN=glpat-... ZAI_API_KEY=zai-...
fly deploy
```

**Add bot cho project GitLab:**

```
Settings → Webhook
  URL: https://pi-bot.example.com/webhook
  Secret: <WEBHOOK_SECRET>
  Trigger: ✅ Merge request events
```

Xong. Mở MR → bot auto-review trong 30s-3min.

📖 **Docs**: [Setup](docs/SETUP.md) · [Project config](docs/CONFIG.md) · [Architecture](docs/ARCHITECTURE.md) · [Multi-project ops](docs/MULTIPROJECT.md)

---

## 🐳 CI Image — cho `.gitlab-ci.yml`

Docker image pre-bake Pi + glab CLI. Dùng trong GitLab CI:

```yaml
# .gitlab-ci.yml (của project khác)
pi:review:
  image: ghcr.io/naicoi92/pi-reviewer:latest
  script:
    - pi --agent code-reviewer --model zai-anthropic/glm-5.2 "..."
```

Image build tự động qua GitHub Actions khi push tag `v*`. Public trên GHCR.

---

## Tính năng

- ✅ **Mức 3 Full Tool** — AI có 5 tools: `fetch_file`, `post_inline_comment`, `post_summary`, `approve_mr`, `request_changes` (tự decide approve qua tool call, không regex)
- ✅ **Inline line comments** — DiffNote qua GitLab Discussions API với position hash
- ✅ **Multi-project** — 1 bot instance phục vụ mọi project GitLab
- ✅ **Auto-review** khi MR mở hoặc push commit mới
- ✅ **Merge gate** — block MR cho đến khi bot approve (GitLab Approval Rule + `block.enabled: true`)
- ✅ **Pi Coding Agent SDK in-process** — không subprocess, type-safe, Z.ai native
- ✅ **Z.ai GLM-5.2** (1M context, $12.6/mo Coding Plan)
- ✅ **Per-project config** qua `.pi/config.yaml`
- ✅ **Concurrency + rate limit** — global 3 song song, 10s cooldown per project
- ✅ **`/stats` endpoint** — observability multi-project
- ✅ **Guardrail chống hallucinate approve** — phải post_summary trước + 0 critical unresolved
- ✅ **Fail-safe** — bot unapprove nếu AI crash trước khi gọi verdict tool

---

## Cấu trúc repo

```
pi-reviewer-bot/
├── Dockerfile                    # CI image (node:22-slim + pi + glab)
├── .dockerignore
├── .github/workflows/build.yml   # build CI image → ghcr.io
│
├── bot/                          # webhook bot service
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile                # bot image (oven/bun:1.1-debian)
# docker-compose.yml ở root
│   ├── .env.example
│   ├── src/
│   │   ├── index.ts              # Hono app entrypoint
│   │   ├── webhook.ts            # verify token + filter + orchestrate
│   │   ├── gitlab.ts             # @gitbeaker/rest wrapper
│   │   ├── repo.ts               # shallow clone per-MR
│   │   ├── pi.ts           # Pi SDK in-process review
│   │   ├── config.ts             # parse .pi/config.yaml
│   │   └── types.ts              # MR webhook payload types
│   └── test/
│       └── webhook.test.ts       # 23 unit tests
│
└── docs/
    ├── SETUP.md                  # deploy Docker + add webhook
    ├── CONFIG.md                 # .pi/config.yaml schema
    └── ARCHITECTURE.md           # design + decision log
```

---

## Tech stack

| Layer | Tech | Lý do |
|---|---|---|
| Runtime | [Bun](https://bun.sh) 1.1+ | Fast startup, native TS, built-in test runner |
| HTTP framework | [Hono](https://hono.dev) | Minimal, fast, web-standard |
| GitLab API | [@gitbeaker/rest](https://gitlab.com/gitlab-org/gitbeaker/) | Typed, maintained, full coverage |
| AI agent SDK | [Pi Coding Agent](https://pi.dev) (`@earendil-works/pi-coding-agent`) | In-process SDK, custom tools, MIT |
| LLM | [Z.ai GLM-5.2](https://z.ai) | 1M context, $12.6/mo Coding Plan, native trong Pi |
| Hosting | Docker (Alpine runtime, multi-arch) | Chạy bất cứ đâu, ~115MB image |
| Registry | [GHCR](https://ghcr.io) | Public image, free for public repos |

---

## Develop locally

```bash
cd bot
bun install
cp .env.example .env  # edit values

# Run with hot reload
bun run dev

# Test
bun test

# Typecheck
bun run typecheck
```

Test webhook locally với curl:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "X-Gitlab-Token: $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d @test/fixtures/mr-open-payload.json
```

---

## License

MIT. Xem [LICENSE](LICENSE).

## Tài liệu

- 📖 [Setup Docker + GitLab webhook](docs/SETUP.md)
- 📖 [Per-project config schema](docs/CONFIG.md)
- 📖 [Architecture + decisions](docs/ARCHITECTURE.md)
- 🔗 [Z.ai Coding Plan](https://z.ai/subscribe)
- 🔗 [Pi docs](https://pi.dev/docs/)
