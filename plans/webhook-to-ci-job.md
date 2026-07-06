# Plan: Webhook Service → CI Job (đảo D1)

> **Status:** chờ approval
> **Breaking change:** project đang dùng webhook phải reconfigure sang CI job
> **Lý do:** CI wait stateful Map phức tạp (ciwait.ts), SHA matching error-prone
> (BUG 5/D14), bot phải online 24/7. CI native `needs:` giải tất cả.

## 1. Mục tiêu

Bỏ webhook service. Bot chạy như 1 GitLab CI job, đặt cuối pipeline (`needs:`
tất cả jobs khác). Pipeline pass → job review chạy.

## 2. Pain point được giải

| Pain hiện tại | Giải pháp CI job |
|---|---|
| `ciwait.ts` in-memory Map — mất khi restart | CI `needs:` native, không cần state |
| SHA matching 3 chỗ khác nhau (BUG 5) | `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` chính xác |
| Pipeline webhook coordination | Không cần — job trigger tự nhiên |
| Bot online 24/7 | Runner ephemeral, scale theo CI |
| `inflight.ts` cancel logic | Mỗi push = pipeline mới, job cũ bị skip/fail |

## 3. Files — xóa / giữ / rewrite

### XÓA (không còn relevant)

- `src/webhook.ts` — verify token + filter action + orchestration
- `src/ciwait.ts` — pending Map + timeout coordinator
- `src/inflight.ts` — AbortController cancel logic
- `src/index.ts` (Hono app) — rewrite thành CLI (xem dưới)
- `src/limiter.ts` — semaphore + cooldown (1 review/job, không concurrent)
- `src/types.ts` — webhook payload types (MergeRequestWebhook, Pipeline)

### GIỮ nguyên

- `src/gitlab.ts` — API client (approve, comment, get diff, get_issue...)
- `src/pi.ts` — Pi SDK wrapper (runPiReview)
- `src/config.ts` — `.pi/config.yaml` loader
- `src/ssrf.ts` — SSRF guard cho fetch_url
- `src/stats.ts` — giữ, đổi sink sang stdout JSON (không còn HTTP `/stats`)
- `src/tools/*` — 12 tools nguyên vẹn
- `src/repo.ts` — simplify (xem dưới)

### REWRITE

- `src/index.ts` — Hono HTTP server → CLI entry point
  - Đọc context từ GitLab CI predefined env vars (không còn webhook payload)
  - Gọi `performReview()` port từ webhook.ts
  - Exit code: 0 = ok/skipped, 1 = error

### MỚI

- `src/context.ts` — `mrContextFromEnv()` thay `mrContextFromWebhook()`
- `.gitlab-ci.example.yml` — template job cho user copy
- `docs/CI_SETUP.md` — onboard guide mới

## 4. Env var contract (GitLab CI predefined)

Job nhận context qua env vars GitLab CI tự set trong MR pipeline:

```
CI_MERGE_REQUEST_IID              → mrIid
CI_PROJECT_ID                     → projectId
CI_PROJECT_PATH                   → projectPath (namespace/name)
CI_PROJECT_URL                    → projectUrl
CI_MERGE_REQUEST_SOURCE_BRANCH_SHA → sourceSha (chính xác, không fallback)
CI_MERGE_REQUEST_TARGET_BRANCH_NAME → targetBranch
CI_API_V4_URL                     → apiBase
GITLAB_TOKEN                      → project CI/CD variable (bot PAT)
DEFAULT_MODEL / ZAI_API_KEY / ...  → LLM provider (project var)
```

## 5. Flow mới (performReview port)

```
1. mrContextFromEnv()           ← đọc CI env vars
2. load .pi/config.yaml         ← từ cwd (CI working dir)
3. unapproveMr (nếu block=true) ← revoke approval cũ ngay
4. fetchMrDiff                  ← GitLab API (không local git)
5. runPiReview                  ← Pi SDK + 12 tools
6. derive outcome từ toolState
7. exit code
```

**Bỏ hoàn toàn:**

- `registerReview` / `completeReview` (inflight)
- `withLimits` (limiter)
- `checkCiAndWait` / `enqueuePendingReview` (ciwait)
- `cloneForReview` (repo.ts) — dùng `process.cwd()` làm repoDir

## 6. `repo.ts` — simplify

`cloneForReview()` không cần — CI runner đã checkout source branch vào cwd.

Đổi: export `repoDir = process.cwd()`. `readFileOrNull` giữ nguyên.
`ClonedRepo.cleanup()` → no-op (runner tự clean).

Giữ option fallback clone nếu chạy local debug (`LOCAL_REPO_PATH`).

## 7. `.gitlab-ci.example.yml` template

```yaml
# Thêm vào .gitlab-ci.yml của project
include:
  remote: 'https://raw.githubusercontent.com/<org>/pi-reviewer-bot/main/templates/review.gitlab-ci.yml'

# HOẶC copy trực tiếp:
pi-review:
  stage: review  # sau test/build
  image:
    name: ghcr.io/<org>/pi-reviewer-bot:latest
    entrypoint: [""]
  needs:          # ← CHỐT: đợi tất cả CI pass
    - job: test
    - job: build
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_STRATEGY: none    # bot dùng GitLab API, không cần checkout
  script:
    - /app/pi-reviewer-bot
```

## 8. Config schema thay đổi

`.pi/config.yaml`:

- **XÓA:** `ci.require`, `ci.waitTimeoutMs` (CI native lo)
- **GIỮ:** `review.*`, `scope.*`, `block.*`, `llm.*`

Env:

- **XÓA:** `WEBHOOK_SECRET`, `CI_WAIT_TIMEOUT_MS`, `PORT`
- **GIỮ:** `GITLAB_TOKEN`, `DEFAULT_MODEL`, LLM keys, `MAX_TOOL_CALLS`

## 9. Migration (breaking)

Project đang dùng webhook:

1. Xóa webhook (MR + Pipeline event) trong GitLab project settings
2. Thêm `.gitlab-ci.yml` include template
3. Set `GITLAB_TOKEN` + LLM key trong CI/CD Variables
4. Bỏ `ci.*` khỏi `.pi/config.yaml`

Bot deployment:

- Bỏ Docker service / k8s deployment
- Publish image lên registry (GHCR / GitLab Registry) cho CI pull

## 10. Test strategy

- `test/context.test.ts` — `mrContextFromEnv()` với mock env vars
- Giữ `test/tools.test.ts`, `test/ssrf.test.ts`
- `test/webhook.test.ts` → rewrite thành `test/review.test.ts` (performReview flow)
- CI tự test: project dogfood chính nó (pi-reviewer-bot review pi-reviewer-bot)

## 11. Open questions

1. **Image registry?** GHCR (public) hay GitLab Registry? AGENTS.md đề cập multi-arch.
2. **Local debug?** Cần CLI flag `--mr <url>` để chạy manual ngoài CI?
3. **`stats.ts` sink?** Stdout JSON line, hay xóa luôn (CI log đủ)?
4. **Timeout?** Job GitLab CI default 1h. Review 5-10 phút OK. Cần env override?

## 12. Thứ tự thực hiện (sau approval)

1. Tạo `src/context.ts` + test
2. Rewrite `src/index.ts` → CLI
3. Port `performReview` (bỏ ciwait/inflight/limiter) → `src/review.ts`
4. Simplify `repo.ts`
5. Xóa webhook.ts, ciwait.ts, inflight.ts, limiter.ts, types.ts (webhook parts)
6. Update config.ts (bỏ ci.* schema)
7. `.gitlab-ci.example.yml` + `docs/CI_SETUP.md`
8. Update README + AGENTS.md (Decision Log: D1-revised)
9. Dockerfile: bỏ EXPOSE/healthcheck, giữ builder
10. Test + typecheck pass
