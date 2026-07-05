# Architecture — pi-reviewer-bot

Tài liệu design cho webhook service. Cập nhật khi architecture thay đổi.

## Overview

```
┌─────────────┐   webhook MR open    ┌─────────────────────────────────┐
│  GitLab MR  │ ───────────────────→ │  pi-reviewer-bot          │
│  (any proj) │                       │  (Hono + Bun, Docker)          │
│             │                       │                                 │
│             │   ◀── post comment ── │  1. verify X-Gitlab-Token       │
└─────────────┘                       │  2. filter action=open/update   │
       ▲                              │  3. skip WIP/dnr                │
       │                              │  4. respond 200 ngay            │
   add webhook 1 lần                  │  5. async: clone repo           │
                                      │  6. load .pi/config.yaml  │
                                      │  7. fetch MR diff (GitLab API)  │
                                      │  8. spawn `pi` SDK        │
                                      │  9. parse JSONL → markdown      │
                                      │ 10. post comment (GitLab API)   │
                                      └─────────────────────────────────┘
                                                  ▲
                                                  │
                                  ┌───────────────┴───────────────┐
                                  │ ZAI_API_KEY env (Coding Plan)  │
                                  │ GITLAB_API_TOKEN env (bot PAT) │
                                  │ WEBHOOK_SECRET env (verify)    │
                                  └───────────────────────────────┘
```

## Components

### 1. Hono app (`src/index.ts`)

HTTP server. Routes:
- `POST /webhook` — GitLab webhook receiver
- `GET /healthz` — Docker healthcheck
- `GET /` — bot info

### 2. Webhook handler (`src/webhook.ts`)

Synchronous phase (must return within 10s — GitLab webhook timeout):
- Verify `X-Gitlab-Token` with `crypto.timingSafeEqual`
- Filter `object_kind === "merge_request"` + `action in [open, update]`
- Skip WIP/dnr (regex match title/branch)
- Schedule async review (`performReview(...).catch(...)`)
- Return 200 `{ accepted: true }`

### 3. Async review pipeline (`performReview`)

```
1. cloneForReview(payload)
   └─ git clone --depth 1 --branch source_branch <token-url> /tmp/...

2. Load .pi/config.yaml (optional)
   └─ mergeConfig(parse(raw)) → ProjectConfig

3. fetchMrDiff(ctx)
   └─ GET /projects/:id/merge_requests/:iid/diffs (keyset pagination)

4. runCodeReview({ repoDir, ctx, diffEntries, model })
   ├─ buildPrompt(ctx, diff, configSummary)
   ├─ spawn `pi` SDK with code-reviewer agent
   ├─ stream-parse JSONL stdout
   └─ extract assistant text from events (defensive across schemas)

5. postMrNote(ctx, markdown)
   └─ POST /projects/:id/merge_requests/:iid/notes

6. cleanup() — rm -rf repo dir
```

### 4. GitLab client (`src/gitlab.ts`)

Wrapper `@gitbeaker/rest`. Singleton, auth via `GITLAB_API_TOKEN`. Methods:
- `fetchMrDiff` — `/diffs` endpoint (non-deprecated)
- `fetchMr` — full MR metadata
- `postMrNote` — post comment
- `authenticatedCloneUrl` — URL with `oauth2:token@` for git clone

### 5. Repo manager (`src/repo.ts`)

Shallow clone source branch. Token inject via URL (git credential). Cleanup rm -rf after review.

### 6. Pi subprocess (`src/pi.ts`)

Spawn `pi` SDK with:
- `--agent code-reviewer` (project-defined in `.pi/agents/`)
- `--model <model>` (default `zai-anthropic/glm-5.2`)
- `--format json` (JSONL stream)
- `--dir <repoDir>` (so Pi finds `.pi/` + `AGENTS.md`)

Stream-parse JSONL — handle 3 known event shapes:
- `{type: "message", role: "assistant", content: "..."}`
- `{type: "message", message: {role, content: [...]}}`
- `{type: "text", text: "..."}`

Timeout 5 phút (configurable `REVIEW_TIMEOUT_MS`).

### 7. Config loader (`src/config.ts`)

Parse `.pi/config.yaml` từ cloned repo. Merge với default. Validate types (reject `language: "fr"`, fall back to default).

## Decisions log

### D1: Webhook service vs GitLab CI job

**Chọn**: Webhook service.

**Lý do**:
- CI job yêu cầu mỗi project sửa `.gitlab-ci.yml` → không scalable
- Webhook service add-once-per-project, hands-off sau đó
- Multi-project central control (rules, keys, model)

**Trade-off**:
- Phải hosting 24/7 (VPS $4-10/mo hoặc self-host)
- Cold start ~5s khi `auto_stop_machines=true` (acceptable cho review async)

### D2: `pi` SDK subprocess vs `@@earendil-works/pi-coding-agent/sdk`

**Chọn**: subprocess.

**Lý do**:
- SDK yêu cầu `pi serve` daemon (long-running HTTP server) — phức tạp lifecycle
- Per-webhook fire-and-forget phù hợp subprocess
- JSONL stream dễ parse, không cần OpenAPI contract

**Trade-off**:
- Cold start mỗi review (~1-2s init)
- Phải handle subprocess issues (#11891 hang, #26855 missing event, #28407 session not found)

### D3: Top-level note vs inline DiffNote

**Chọn**: Top-level note (MVP).

**Lý do**:
- Inline line comments cần Discussions API với `position` hash (base_sha/head_sha/start_sha/new_path/old_path/new_line) — phức tạp
- Top-level note đủ cho 90% use case
- DiffNote trong roadmap sau MVP

### D4: `setImmediate` async vs job queue (BullMQ/Redis)

**Chọn**: `setImmediate` (MVP).

**Lý do**:
- Volume thấp (<50 MR/ngày) — queue overhead không đáng
- Không cần retry/persistence (review fail → bot post error comment, user retry)
- BullMQ cần Redis ($10/mo) — overkill cho MVP

**Trade-off**:
- Nếu bot restart giữa review → mất review đó (user re-push để trigger lại)
- Không có backpressure — nếu 100 webhook cùng lúc → spawn 100 subprocess → OOM

### D5: Docker container (Alpine + Bun --compile)

**Chọn**: Docker container với multi-stage build (Bun alpine builder → alpine runtime).

**Lý do**:
- Image nhẹ (~115MB) nhờ `bun build --compile` ra standalone binary
- Alpine có shell để debug, không hardcore như distroless
- Multi-arch (amd64 + arm64) qua buildx
- Chạy bất cứ đâu: VPS, homelab, K8s, ECS, local

**Alternatives đã loại**:
- ❌ **Fly.io** — lock-in cloud, không chạy được ở homelab
- ❌ **Distroless** — không có shell, khó debug, cần copy git binary thủ công
- ❌ **node:22 full** — image ~1GB, quá nặng
- ❌ **Cloudflare Workers** — không spawn subprocess được

**Trade-off**:
- Phải tự manage hosting (VPS/K8s/systemd)
- Không auto-scaling built-in (nhưng bot có semaphore + rate limit)

### D6: Per-project config qua file trong repo

**Chọn**: `.pi/config.yaml` trong source repo.

**Lý do**:
- Config đi cùng code (version-controlled, review-able)
- Bot clone source branch → có ngay config mới nhất
- Không cần database hay central config store

**Trade-off**:
- Project phải opt-in bằng cách tạo file (nhưng default hoạt động luôn)
- Config change phải commit + push để apply (không live-update)

### D7: Merge gate qua Approval API (không phải commit status)

**Chọn**: GitLab MR Approvals (`POST /approve` + `DELETE /approve`) kết hợp với project-level Approval Rule.

**Lý do**:
- Approval API miễn phí (Free tier), ở tất cả self-managed
- Approval Rule cho phép chỉ định bot làm required approver → block merge thực sự
- Tự reset khi push commit mới → bot re-review tự nhiên
- User override được (manually approve) cho case khẩn cấp

**Alternatives đã loại**:
- ❌ **Commit Status API** (external pipeline status) — phức tạp hơn, cần tạo pipeline mock, không reset auto khi push
- ❌ **Protected branches + merge checks** — không linh hoạt bằng per-MR approval
- ❌ **Webhook intercept merge** — GitLab không có "merge blocked" webhook tùy chỉnh

**Trade-off**:
- Bot account phải là member của project (Developer+) — không "global bot" cho mọi project tự động
- Bot failure → MR blocked cho đến khi fix bot (conservative, có thể override manual)
- Approval gate chỉ kích hoạt nếu project setup Approval Rule (mặc định OFF)

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pi subprocess hang | Medium | High | Timeout 5 phút + SIGTERM kill |
| `pi SDK event stream` schema đổi | Medium | Medium | Defensive parse 3 shapes, fallback stderr |
| GitLab API rate limit | Low | Medium | Throttle 10 req/s, cache diff |
| Z.ai Coding Plan throttle | Medium | Medium | Lite $12.6 có quota cao, monitor usage |
| Bot OOM trên MR lớn | Medium | High | Cap diff 200KB, maxFiles=100, post-MVP chunking |
| Webhook secret leak | Low | Critical | Fly secrets encrypted, timing-safe compare |
| Repo clone fail (private project, wrong token) | Low | High | Catch error, post error comment |

## Roadmap (post-MVP)

| # | Feature | Priority | Effort |
|---|---|---|---|
| 1 | Inline line comments (DiffNote qua Discussions API) | High | 2-3 days |
| 2 | Job queue (BullMQ + Redis) cho retry + backpressure | Medium | 1-2 days |
| 3 | Web UI dashboard (status, history, per-project config) | Medium | 1 week |
| 4 | Multi-tenant: per-project GitLab token | Low | 1 week |
| 5 | Auto-fix: bot commit fix vào MR | Low | 3-5 days |
| 6 | Review status check (GitLab Pipeline Status API) | Low | 2 days |
| 7 | Slash command runtime (`@pi-bot rebase`) | Low | 1 week |
| 8 | Multi-LLM routing (per-project chọn DeepSeek/Z.ai/OpenAI) | Low | 2 days |

## Metrics (post-MVP)

Cần track:
- Review latency p50/p95/p99
- Pi subprocess exit code distribution
- Pi token usage per review
- Webhook → comment end-to-end time
- Bot error rate (cloning / API / pi / posting)
- Per-project review volume

Implement qua OpenTelemetry → GlitchTip (project đã có plan dùng GlitchTip).
