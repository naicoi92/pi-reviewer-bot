# Architecture — pi-reviewer-bot

> ⚠️ **D17 (2026-07): kiến trúc ĐẢO** từ webhook service sang **GitLab CI job**.
> Tài liệu này mô tả kiến trúc webhook (PRE-D17) — giữ làm **lịch sử design**.
> Kiến trúc hiện tại: xem [README](../README.md) + [USAGE](USAGE.md) + Decision Log
> D17 trong [AGENTS.md](../AGENTS.md). Phần webhook-specific (`webhook.ts`,
> `ciwait.ts`, `inflight.ts`, `limiter.ts`) đã XÓA.

Tài liệu design cho webhook service (PRE-D17). Cập nhật khi architecture thay đổi.

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
       │   webhook pipeline success   │  5. async: clone repo           │
       │   ─────────────────────────→ │  6. load .pi/config.yaml  │
       │   (chỉ khi ci.require=true)  │  7. CI wait check (if ci.require)│
       │                              │     CI running → enqueue pending│
       │                              │     CI pass → fetch diff        │
       │                              │  8. fetch MR diff (GitLab API)  │
       │                              │  9. spawn `pi` SDK        │
       │                              │ 10. parse JSONL → markdown      │
       │                              │ 11. post comment (GitLab API)   │
                                      └─────────────────────────────────┘
                                                  ▲
                                                  │
                                  ┌───────────────┴───────────────┐
                                  │ ZAI_API_KEY env (Coding Plan)  │
                                  │ GITLAB_API_TOKEN env (bot PAT) │
                                  │ WEBHOOK_SECRET env (verify)    │
                                  │ CI_WAIT_TIMEOUT_MS env (10min) │
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

### 8. CI wait coordinator (`src/ciwait.ts`)

Bridge giữa MR webhook và Pipeline webhook khi project bật `ci.require: true`:

- **State**: in-memory `Map<projectId:sha, PendingReview>` — không persist.
- **Flow**:
  1. MR webhook đến + CI running → `enqueuePendingReview` lưu payload + set timeout GC.
  2. Pipeline webhook `status=success` → `consumePendingReview` lấy payload + clear timeout → trigger `performReview({ skipCiCheck: true })`.
  3. Timeout fire (CI >10 phút) → callback → review anyway.
- **Key là `projectId:sha`** — match pipeline với MR chính xác tại commit, robust với re-push.
- **Secondary index `projectId:mrIid → sha`** — clear entry cũ khi re-push (fix BUG 1).
- **Trade-off**: mất khi bot restart → user push retry (cùng pattern bot error hiện tại).

### 9. In-flight review coordinator (`src/inflight.ts`)

Cancel review cũ khi review mới bắt đầu (fix BUG 3):

- **State**: in-memory `Map<projectId:mrIid, InFlightReview>` — không persist.
- **Flow**:
  1. `performReview` bắt đầu → `registerReview(payload)` trả về `InFlightReview` chứa `AbortController`.
  2. Nếu có entry cũ cho cùng MR IID → `abortController.abort()` → `runPiReview` listener → `session.abort()` → SDK reject → performReview catch → return không post note.
  3. `runPiReview({ abortSignal })` — listener external abort (vs `REVIEW_TIMEOUT_MS` timeout, dùng chung `session.abort()`).
  4. `performReview` `finally` → `completeReview()` clear entry để review kế tiếp không abort nhầm.
- **Key là `projectId:mrIid`** — 2 MR khác nhau không cancel lẫn nhau (chỉ cùng MR mới cancel).
- **Trade-off**: review cũ bị abort mất token đã dùng tới lúc abort (~1-2 phút), nhưng tránh được duplicate comment + race condition.

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

### D10: CI wait qua pipeline webhook + stateful Map in-memory

**Chọn**: Khi project bật `ci.require: true`, bot đợi CI pass mới review. Implement bằng cách listen thêm pipeline webhook + stateful `Map<projectId:sha, payload>` in-memory.

**Lý do**:

- Tiết kiệm token AI — không review code mà CI sẽ catch lỗi (lint/typecheck/test fail)
- Pipeline webhook event-driven, không polling → ít GitLab API call, không tốn slot semaphore khi chờ
- Stateful Map đơn giản, không cần Redis — volume thấp (<50 MR/ngày)
- SHA matching (không MR matching) → robust với re-push, chính xác commit đang review
- Per-project timeout override qua `.pi/config.yaml` → monorepo CI chậm không bị cutoff
- Aggregate TẤT CẢ pipeline cùng SHA → không miss fail của branch pipeline khi MR pipeline success (workflow GitLab chuẩn)
- Secondary index `mrIid → sha` clear entry cũ khi re-push → tránh stale trigger

**Alternatives đã loại**:

- ❌ **Poll pipeline status** (setInterval 30s × 10 phút) — tốn GitLab API call, giữ slot semaphore khi chờ (3 MR chờ CI = block hết slot review)
- ❌ **Redis persist pending** — thêm dependency ($10/mo), overkill cho MVP
- ❌ **Job-level webhook** (build events) — quá chi tiết, chỉ cần pipeline aggregate status
- ❌ **Block toàn server (default on)** — nguy hiểm cho project chưa setup CI
- ❌ **Chỉ check `pipelines[0]`** — có thể miss fail pipeline khác cùng SHA (vd branch pipeline fail trong khi MR pipeline success)
- ❌ **Track pending theo MR IID thay vì SHA** — không match được pipeline webhook với entry (pipeline webhook có SHA, không có MR IID)

**Trade-off**:

- Bot restart → pending CI wait mất (user push commit retry). Note trong Known Limitations.
- Cần project enable thêm "Pipeline events" webhook (manual setup step)
- Repo chưa setup CI → bot review anyway (lenient, không block team chưa có CI)
- Parent-child pipeline (downstream, `trigger:` keyword) không tracked — chỉ check parent. Workaround: `needs:` trong CI config.

### D11: Cancel review cũ qua AbortController khi push mới

**Chọn**: Khi review mới bắt đầu cho cùng MR IID, abort review cũ đang chạy qua `AbortSignal` → `session.abort()`.

**Lý do**:

- Tránh 2 review song song trên cùng MR → duplicate comment, race condition approve/unapprove, sai SHA diff (GitLab reject inline comment với position hash mismatch)
- `AbortSignal` là web standard, Pi SDK đã expose `session.abort()` (dùng cho REVIEW_TIMEOUT_MS) → reuse pattern
- Key theo `projectId:mrIid` (không phải SHA) — 2 MR khác nhau không cancel lẫn nhau
- Review cũ bị abort → SDK reject `agentEnded` → performReview catch → return KHÔNG post note (im lặng) → review mới sẽ lo toàn bộ verdict
- Token đã dùng tới lúc abort (~1-2 phút phần lớn) bị mất, nhưng tránh được noise lớn hơn

**Alternatives đã loại**:

- ❌ **Skip webhook mới (1 review tại 1 thời điểm)** — user push 5 commit liên tiếp chỉ commit đầu được review, phải push commit rỗng để re-trigger
- ❌ **Discard kết quả review cũ nếu SHA mismatch** — vẫn tốn token review cũ, vẫn có thể approvetool đã gọi GitLab API giữa chừng
- ❌ **Queue review mới, đợi review cũ xong** — tăng latency, phức tạp hơn (cần queue per-MR)
- ❌ **Track theo SHA thay vì MR IID** — không catch được case re-push với webhook duplicate (cùng SHA)

**Trade-off**:

- Abort xảy ra giữa chừng tool call (vd approve đã gọi GitLab API) → không rollback. Trade-off chấp nhận được — rare, review mới sẽ cover với verdict mới.
- Bot restart → inflight lost → user push retry (cùng pattern CI wait + bot error).

### D12: Unapprove đồng bộ khi push mới + block=true

**Chọn**: Khi `performReview` bắt đầu (sau load config) và `cfg.block.enabled = true`, gọi `unapproveMr(ctx)` đồng bộ **trước** khi fetch diff / CI wait / run review.

**Lý do**:

- Đóng "merge window" của BUG 4: khi push commit mới + project có GitLab "Reset approval on push" = OFF → approval cũ (cho SHA trước) vẫn còn hiệu lực → user có thể merge code chưa review trong window 30s-5 phút (hoặc 10+ phút nếu CI wait)
- Unapprove idempotent (`gitlab.ts:unapproveMr` coi 404/405 = no-op) → an toàn cho MR mở lần đầu
- Đặt sau `load config` để biết `block.enabled`; đặt trước `CI wait` để MR blocked cả khi đợi CI

**Alternatives đã loại**:

- ❌ **Chỉ depend GitLab "Reset approval on push"=ON** — không phải project nào cũng enable, bot không control
- ❌ **Unapprove trong `request_changes` tool** — chỉ chạy khi AI verdict FAIL, không cover case AI đang review (chưa verdict)
- ❌ **Poll approval state trong khi review** — phức tạp, tốn GitLab API call

**Trade-off**:

- 1 GitLab API call thêm mỗi review (cost nhỏ ~50ms)
- Project có GitLab "Reset approval on push"=ON → unapprove no-op (idempotent) → không phá gì

### D14: SHA resolution consistent qua 3 modules (fix BUG 5)

**Chọn**: `mrContextFromWebhook` fallback `mr.source_branch_sha ?? mr.last_commit?.id` — consistent với `ciwait.ts:enqueuePendingReview` và `inflight.ts:registerReview`.

**Lý do**:

- BUG 5 gốc: `mrContextFromWebhook` không fallback → `MrContext.sourceSha` undefined khi webhook không gửi `source_branch_sha` (xảy ra ở open/reopen event + nhiều GitLab self-managed versions)
- `getMrPipelineStatus` filter theo SHA undefined → lấy TẤT CẢ pipelines của MR kể cả zombie cũ → aggregate "running" → bot enqueue đợi → stuck 10 phút timeout
- 3 chỗ resolve SHA (ciwait, inflight, mrContextFromWebhook) phải agree — cùng payload phải ra cùng SHA, không thì pipeline webhook consume được entry nhưng pipeline status check filter sai

**Alternatives đã loại**:

- ❌ **Refactor `MrContext.sourceSha` thành required field** — break nhiều call sites, overkill cho edge case
- ❌ **Skip pipeline list khi SHA undefined** — khắt khe quá, fail close → bot không review được khi có thể vẫn hoạt động bình thường
- ❌ **Lấy tất cả pipelines khi SHA undefined (pre-fix behavior)** — bug gốc, có thể include zombie running

**Trade-off**:

- Khi cả 2 field undefined (hiếm): fallback "chỉ lấy pipeline mới nhất" (top of GitLab list, sort by created_at desc) + log warn. Best-effort — có thể miss multi-pipeline aggregate nhưng tránh zombie pipeline.

### D15: Pipeline webhook handler log mọi skip path (fix BUG 6)

**Chọn**: 3 skip path + 1 happy path đều `console.log` với format `[webhook] pipeline <skip|success> <project>@<short-sha> — <reason>`.

**Lý do**:

- BUG 6: trước đây 3 skip path silent → user không debug được "CI đã pass nhưng bot không review" qua `docker logs`
- Consistent với MR webhook skip log (`[webhook] skip !XX — reason`)
- Log成本低 (~1 dòng/log), debug giá trị cao — pipeline webhook là điểm fail silent phổ biến

**Alternatives đã loại**:

- ❌ **Structured logging (pino/winston)** — overkill cho MVP, không có log aggregation setup
- ❌ **Tăng log level lên debug + flag** — phức tạp, không cần thiết với volume thấp

**Trade-off**:

- Log nhiều hơn (3 dòng/webhook) — không đáng kể với volume thấp (<50 MR/ngày)

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
| Bot restart mất pending CI wait | Low | Medium | User push commit retry (cùng pattern bot error) |
| Project quên enable "Pipeline events" webhook | Medium | Low | Bot log warning + fallback review sau timeout |
| Parent-child pipeline (downstream) không tracked | Low | Low | Document Known Limitation, workaround `needs:` |
| Multi-pipeline race (branch fail + MR success) | Medium | Medium | Aggregate TẤT CẢ pipeline cùng SHA, require tất cả pass |
| Review cũ bị abort giữa tool call (approve đã gọi) | Low | Low | Trade-off chấp nhận — review mới sẽ cover verdict |
| Re-push khi đang review (race 2 review) | Medium | High | Cancel review cũ qua AbortController (D11) |
| Push mới + block=true giữ approval cũ → merge code chưa review | Medium | High | Unapprove đồng bộ ở entry point performReview (D12) |

## Roadmap (post-MVP)

| # | Feature | Priority | Effort |
|---|---|---|---|
| 1 | Inline line comments (DiffNote qua Discussions API) | High | 2-3 days |
| 2 | Job queue (BullMQ + Redis) cho retry + backpressure | Medium | 1-2 days |
| 3 | Web UI dashboard (status, history, per-project config) | Medium | 1 week |
| 4 | Multi-tenant: per-project GitLab token | Low | 1 week |
| 5 | Auto-fix: bot commit fix vào MR | Low | 3-5 days |
| 6 | ~~Review status check (GitLab Pipeline Status API)~~ ✅ Done — implemented as CI wait mode (D10) | Low | 2 days |
| 7 | Slash command runtime (`@pi-bot rebase`) | Low | 1 week |
| 8 | Multi-LLM routing (per-project chọn DeepSeek/Z.ai/OpenAI) | Low | 2 days |
| 9 | Persist CI wait pending sang Redis/disk | Low | 1 day |

## Metrics (post-MVP)

Cần track:

- Review latency p50/p95/p99
- Pi subprocess exit code distribution
- Pi token usage per review
- Webhook → comment end-to-end time
- Bot error rate (cloning / API / pi / posting)
- Per-project review volume

Implement qua OpenTelemetry → GlitchTip (project đã có plan dùng GlitchTip).
