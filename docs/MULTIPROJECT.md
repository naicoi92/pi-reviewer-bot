# Multi-project Operations

Bot được thiết kế để phục vụ nhiều project GitLab cùng lúc. Tài liệu này mô tả cách vận hành ở quy mô lớn.

## Mô hình triển khai

```
                    ┌─────────────────────────────┐
   project A ──────►│                             │
   project B ──────►│  pi-reviewer-bot      │──── Z.ai GLM-5.2
   project C ──────►│  (1 Docker container)       │     (1 API key)
   project D ──────►│                             │
                    │  Concurrency: 3 song song   │
                    │  Rate limit: 10s / project  │
                    └─────────────────────────────┘
```

**1 bot instance** phục vụ mọi project. Mỗi project:

- Có webhook riêng tới cùng URL
- Có `.pi/config.yaml` riêng trong repo (optional)
- Có `.pi/agents/code-reviewer.md` riêng (optional)
- Dùng chung 1 ZAI_API_KEY + GITLAB_API_TOKEN

---

## Thêm bot cho project mới (3 bước, <2 phút)

### Bước 1 — Tạo bot PAT cho project (nếu bot chưa phải member)

Bot PAT owner phải là Developer+ của project. Có 2 mô hình:

**Mô hình A — Group-level bot** (khuyến nghị nếu project cùng group):

```
GitLab group → Settings → Access Tokens
  - Name: pi-bot
  - Role: Developer
  - Scopes: api
  - Apply to: all projects in group
```

→ 1 token dùng cho mọi project trong group.

**Mô hình B — Project-level member** (bot cá nhân join nhiều project):

```
Project → Settings → Members → Invite
  - @your-bot-account
  - Role: Developer
```

→ Bot dùng cùng 1 PAT (đã set trong `fly secrets`) cho mọi project.

### Bước 2 — Add webhook

```
Project → Settings → Webhook
  URL: https://pi-bot.example.com/webhook
  Secret: <WEBHOOK_SECRET>      ← cùng giá trị cho mọi project
  Trigger: ✅ Merge request events
```

### Bước 3 — (Optional) Project config

Trong repo project, tạo `.pi/config.yaml` để tuỳ biến:

```yaml
review:
  language: en              # tiếng Anh thay vì VN
  skipBranchRegex: "^(wip|scratch|dependabot)/.*"

scope:
  enabled: true             # bật scope check (cần có task convention)
  convention: "feat/T-XX-*"
  resolvesPattern: "Closes #(\\d+)"
  taskIndex: docs/TASKS.md

block:
  enabled: true             # block merge cho đến khi bot approve
```

Commit + push. Xong.

---

## Observability — `/stats` endpoint

Bot có endpoint `/stats` cho thấy tình trạng mọi project đang phục vụ:

```bash
curl https://pi-bot.example.com/stats | jq .
```

```json
{
  "global": {
    "totalReviews": 247,
    "totalErrors": 3,
    "byOutcome": {
      "approved": 198,
      "unapproved": 43,
      "skipped": 3,
      "error": 3
    },
    "uptimeMs": 187200000,
    "projectsTracked": 4
  },
  "concurrency": {
    "active": 1,
    "max": 3
  },
  "projects": [
    {
      "projectPath": "lttech-ga/live-stream",
      "total": 142,
      "byOutcome": { "approved": 120, "unapproved": 19, "skipped": 1, "error": 2 },
      "avgDurationMs": 48200,
      "successRate": 84.5,
      "lastReviewAt": 1720000000000,
      "lastMrIid": 87
    },
    {
      "projectPath": "acme/payment-service",
      "total": 68,
      "byOutcome": { "approved": 55, "unapproved": 12, "skipped": 1, "error": 0 },
      "avgDurationMs": 35000,
      "successRate": 80.9,
      "lastReviewAt": 1719999900000,
      "lastMrIid": 14
    }
  ]
}
```

**Metric quan trọng để watch:**

| Metric | Healthy | Cảnh báo |
|---|---|---|
| `global.totalErrors / totalReviews` | <5% | >10% → bot đang break |
| `projects[].avgDurationMs` | <60s | >120s → MR quá lớn hoặc Z.ai chậm |
| `projects[].successRate` | >70% | <50% → agent hay false-positive |
| `concurrency.active` | <max | =max liên tục → tăng MAX_CONCURRENT_REVIEWS |

### Bảo mật `/stats`

Mặc định `/stats` **public** (chỉ chứa aggregate counts, không secrets). Để require auth:

```bash
fly secrets set STATS_AUTH_TOKEN=$(openssl rand -hex 16)
```

Sau đó gọi với Bearer:

```bash
curl -H "Authorization: Bearer $STATS_AUTH_TOKEN" \
     https://pi-bot.example.com/stats
```

### Dashboard (post-MVP)

Hooks để build dashboard:
- Poll `/stats` mỗi 30s → Grafana / GlitchTip
- Hoặc bot push metric qua webhook (post-MVP: OpenTelemetry)

---

## Concurrency & Rate limiting

Bot có 2 lớp bảo vệ để không OOM / không throttle Z.ai:

### Global concurrency

```bash
# Default: 3 review song song
fly secrets set MAX_CONCURRENT_REVIEWS=3
```

Mỗi review giữ: 1 repo clone + 1 Pi subprocess + ~200MB RAM.
- 512MB Fly machine → MAX_CONCURRENT=2-3 an toàn
- 1GB Fly machine → MAX_CONCURRENT=5-7

### Per-project rate limit

```bash
# Default: 1 review / 10s cho mỗi project
fly secrets set PER_PROJECT_COOLDOWN_MS=10000
```

Chống infinite loop khi project có webhook config sai (vd trigger nhiều lần cho cùng MR).

### Khi nào tăng limits?

| Tình huống | Action |
|---|---|
| Project có MR push liên tục (10+ commit trong 1 phút) | Giảm `REVIEW_TIMEOUT_MS`, tăng `PER_PROJECT_COOLDOWN_MS` |
| 5+ project active cùng lúc | Tăng `MAX_CONCURRENT_REVIEWS` + upgrade Fly machine memory |
| Z.ai Coding Plan throttle | Giảm concurrency, upgrade Pro/Max tier |

---

## Per-project LLM backend (tùy chọn)

Mặc định: tất cả project dùng chung 1 LLM (Z.ai GLM-5.2). Project có thể override:

```yaml
# .pi/config.yaml
llm:
  model: deepseek/deepseek-chat
```

⚠️ **Yêu cầu**: Bot phải có env var `DEEPSEEK_API_KEY` set:

```bash
fly secrets set DEEPSEEK_API_KEY=sk-xxxxx
```

Provider hỗ trợ (qua Pi `{env:VAR}` interpolation trong `pi.json`):

| Provider | Env var | Cost |
|---|---|---|
| Z.ai GLM-5.2 | `ZAI_API_KEY` | $12.6/mo Lite (default) |
| DeepSeek | `DEEPSEEK_API_KEY` | ~$0.005/MR |
| OpenAI | `OPENAI_API_KEY` | ~$0.05/MR |
| Anthropic | `ANTHROPIC_API_KEY` | ~$0.15/MR |
| Ollama local | (không cần key) | Free nhưng bot phải reach Ollama host |

---

## Quản lý token GitLab ở quy mô lớn

### Vấn đề

Khi bot phục vụ 20+ project, dùng 1 PAT cho tất cả có rủi ro:
- PAT owner rời công ty → toàn bộ bot die
- PAT có scope quá rộng (api = mọi project owner có quyền)
- Không audit được bot activity per-project

### Giải pháp phân tân

**Mô hình 1 — Group bot (khuyên dùng)**:

Mỗi GitLab group có 1 bot account riêng:
- `lttech-ga/pi-bot` (PAT riêng, scope api)
- `acme-org/pi-bot` (PAT riêng khác)

Bot service cần multiple PAT support — hiện **chưa có ở MVP**. Post-MVP feature.

**Mô hình 2 — 1 PAT dùng chung** (hiện tại):

Acceptable khi:
- <10 project
- Tất cả project cùng trust level
- Bot owner là dev lâu năm, không rời công ty sớm

Để upgrade sang mô hình 1, vote/PR cho issue "multi-token support" (post-MVP).

---

## Scaling thresholds

Khi nào cần scale up bot?

| Signal | Hành động |
|---|---|
| `/stats` `concurrency.active = max` liên tục | Tăng `MAX_CONCURRENT_REVIEWS` |
| `avgDurationMs > 120000` (2 phút) | Tách MR lớn hơn, hoặc giảm `REVIEW_TIMEOUT_MS` |
| OOM crash (Container restart policy) | Tăng `vm.memory` trong `docker-compose.yml` |
| Z.ai 429 throttle | Tăng Coding Plan tier hoặc giảm concurrency |
| Fly free tier hết ($ credit) | Upgrade sang Fly paid plan ($5/mo) |

Khi nào cần multiple bot instances (multi-region)?

- 50+ project active
- Latency >5s từ VN → Fly Singapore
- Need region failover

→ Deploy 2 bot instances (EU + AP), DNS round-robin. Post-MVP.

---

## Default env vars (multi-project)

Thêm vào `.env.example`:

```bash
# Multi-project tuning
MAX_CONCURRENT_REVIEWS=3         # song song global
PER_PROJECT_COOLDOWN_MS=10000    # 10s giữa các review cùng project
REVIEW_TIMEOUT_MS=300000         # 5 phút timeout/review
STATS_AUTH_TOKEN=                # optional Bearer cho /stats
```

---

## Audit trail

Bot log mọi review với `[review !N]` prefix. Lấy log 1 project cụ thể:

```bash
fly logs | grep "lttech-ga/live-stream"
```

Mỗi review ghi:
- `[review !N] start — <project> @ <branch>`
- `[review !N] acquired review slot` (sau khi qua rate limit)
- `[review !N] cloned to ... (pi config: true/false)`
- `[review !N] fetched N file diffs`
- `[review !N] pi finished in Xms — ok=true events=Y`
- `[review !N] verdict: APPROVE (block=true)`
- `[review !N] approve: ok`
- `[review !N] done — outcome=approved duration=Xms`

→ Đủ để debug bất kỳ issue nào từ log.

---

## Roadmap multi-project (post-MVP)

| Feature | Priority | Mô tả |
|---|---|---|
| Multi-token GitLab (per-project PAT) | High | Override GITLAB_API_TOKEN per project qua central config |
| Project registration API | Medium | `POST /projects` để tự add webhook thay vì manual |
| Webhook signature rotation | Medium | Auto-rotate WEBHOOK_SECRET định kỳ |
| Per-project quota | Low | Giới hạn số review/project/ngày |
| Multi-region deploy | Low | Bot EU + AP cho global team |
| OpenTelemetry export | Low | Truyền metric ra Grafana Cloud |
| Webhook URL discovery | Low | Bot liệt kê project đang serve qua `/projects` endpoint |
