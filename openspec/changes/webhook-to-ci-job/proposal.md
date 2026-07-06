# Proposal: webhook-to-ci-job

> **Đảo Decision D1** — chuyển bot từ webhook service sang GitLab CI job.
> Status: draft (chờ review trước khi qua phase spec/design).
> Breaking change: **major semver bump**, hard cutover, không deprecation window.

## 1. Why (Tại sao)

Bot hiện chạy như một **webhook service** online 24/7 (Hono HTTP server, nhận MR +
Pipeline events). Kiến trúc này sinh ra 4 pain point thực tế, đã làm chậm và gây bug:

1. **`ciwait.ts` — stateful in-memory Map.** Pending review giữ trong RAM giữa MR
   webhook và pipeline webhook. Mất hoàn toàn khi bot restart → user phải push lại
   commit để retry review. Decision D10.
2. **SHA matching error-prone ở 3 chỗ khác nhau.** `webhook.ts`, `ciwait.ts`,
   `inflight.ts` mỗi chỗ resolve source SHA theo cách riêng → BUG 5 (fix D14) phải
   thống nhất `source_branch_sha ?? last_commit.id`. Vẫn là landmine cho sửa sau.
3. **Bot phải online 24/7.** Docker service / k8s deployment cố định. Không scale
   theo tải, single point of failure, ops burden.
4. **`inflight.ts` cancel logic phức tạp.** Khi push mới tới giữa review cũ, dùng
   `AbortController` cancel review đang chạy (D11) + unapprove đồng bộ (D12) để chặn
   race condition (2 review song song, duplicate comment, diff sai SHA). Bản chất đây
   là workaround cho việc webhook + async review không tự đồng bộ.

GitLab CI giải tất cả bằng cơ chế native: pipeline chạy review job **sau khi** mọi
job khác pass (`needs:`), mỗi push = pipeline mới (review cũ tự bị thay thế), SHA lấy
từ `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` (chính xác, không fallback). Runner ephemeral,
không cần bot online.

## 2. What Changes (Scope IN)

Bot chạy như **1 GitLab CI job** đặt cuối pipeline (`needs:` tất cả job test/build).
Pipeline pass → job review chạy → approve/request_changes MR qua GitLab API.

### XÓA (webhook-only code, không còn relevant)

- `src/webhook.ts` — verify token + filter action + orchestrate review
- `src/ciwait.ts` — pending Map + timeout coordinator (D10)
- `src/inflight.ts` — AbortController cancel logic (D11/D12)
- `src/limiter.ts` — semaphore + cooldown (1 review/job, không concurrent)
- `src/types.ts` — webhook payload types (`MergeRequestWebhook`, `Pipeline`)
- `src/index.ts` (Hono HTTP server) — rewrite thành CLI entry point
- HTTP endpoints `/webhook`, `/healthz`, `/stats`

### GIỮ nguyên (GitLab API + Pi SDK core)

- `src/gitlab.ts` — API client (approve, comment, get diff, get_issue, pipeline status...)
- `src/pi.ts` — Pi SDK wrapper (`runPiReview`)
- `src/config.ts` — `.pi/config.yaml` loader (bỏ `ci.*` schema)
- `src/ssrf.ts` — SSRF guard cho `fetch_url`
- `src/repo.ts` — simplify (xem Behavior)
- `src/stats.ts` — giữ, đổi sink sang stdout JSON line (không còn HTTP `/stats`)
- `src/tools/*` — 12 tools nguyên vẹn

### REWRITE

- `src/index.ts` — Hono HTTP server → **CLI entry point**. Đọc context từ GitLab CI
  predefined env vars (không còn webhook payload), gọi `performReview()`, exit code
  quyết định pass/fail job.

### MỚI

- `src/context.ts` — `mrContextFromEnv()` thay `mrContextFromWebhook()`
- `src/review.ts` — `performReview()` port từ `webhook.ts` (bỏ ciwait/inflight/limiter)
- `templates/review.gitlab-ci.yml` — template job cho user include
- `docs/CI_SETUP.md` — onboard guide chế độ CI job

## 3. Behavior (Yêu cầu behavior)

### 3.1 CLI flow

```
1. mrContextFromEnv()            ← đọc CI env vars
2. loadConfig() (cwd)            ← .pi/config.yaml
3. unapproveMr (nếu block=true)  ← revoke approval cũ ngay
4. fetchMrDiff                   ← GitLab API (không local git clone)
5. runPiReview                   ← Pi SDK + 12 tools
6. derive outcome từ toolState
7. process.exit(outcome === ok ? 0 : 1)
```

Bỏ hoàn toàn: `registerReview`/`completeReview` (inflight), `withLimits` (limiter),
`checkCiAndWait`/`enqueuePendingReview` (ciwait), `cloneForReview` (repo.ts).

### 3.2 Exit-code contract (JOB-FAIL = BLOCK)

- `exit 0` = review ok (approve hoặc request_changes có chủ đích) → MR unblock theo
  outcome (request_changes vẫn giữ block, nhưng job pass).
- `exit != 0` = review fail (timeout, LLM error, network, inconclusive) → **MR giữ
  blocked**, user re-run pipeline. **Đây là intended safe-default, không phải bug.**

### 3.3 Env-var contract (GitLab CI predefined)

```
CI_MERGE_REQUEST_IID               → mrIid
CI_PROJECT_ID                      → projectId
CI_PROJECT_PATH                    → projectPath (namespace/name)
CI_PROJECT_URL                     → projectUrl
CI_MERGE_REQUEST_SOURCE_BRANCH_SHA → sourceSha (chính xác, KHÔNG fallback)
CI_MERGE_REQUEST_TARGET_BRANCH_NAME → targetBranch
CI_API_V4_URL                      → apiBase
GITLAB_TOKEN                       → project CI/CD variable (bot PAT)
DEFAULT_MODEL / ZAI_API_KEY / ...  → LLM provider keys (project var)
```

### 3.4 `repo.ts` simplify

`cloneForReview()` không cần — CI runner đã checkout source branch vào `process.cwd()`.
Đổi: export `repoDir = process.cwd()`. `readFileOrNull` giữ nguyên. `ClonedRepo.cleanup()`
→ no-op (runner tự clean). Giữ fallback `LOCAL_REPO_PATH` cho debug ngoài CI.

## 4. Non-goals (Scope OUT)

- **Dual-mode** — KHÔNG giữ webhook service song song. CI job là mode duy nhất.
- **Deprecation window** — KHÔNG giữ webhook chạy N release. Hard cutover.
- **Backward-compat shim** cho webhook payload / `WEBHOOK_SECRET` / `PORT`.
- **`ci.*` config schema** (`ci.require`, `ci.waitTimeoutMs`) — CI native lo.
- **Slash command runtime**, Web UI dashboard, auto-fix commits, multi-tenant token
  (giữ nguyên Known Limitations post-MVP).

## 5. Impact (Ảnh hưởng)

### Breaking change

Project đang dùng webhook **phải reconfigure**:

1. Xóa webhook (MR + Pipeline event) trong GitLab project settings.
2. Thêm `.gitlab-ci.yml` include template (hoặc copy `templates/review.gitlab-ci.yml`).
3. Set `GITLAB_TOKEN` + LLM key trong CI/CD Variables.
4. Bỏ `ci.*` khỏi `.pi/config.yaml`.
5. Bỏ Docker service / k8s deployment của bot; publish image lên GHCR cho CI pull.

### Affected files (summary)

- Xóa 5 file (`webhook.ts`, `ciwait.ts`, `inflight.ts`, `limiter.ts`, types webhook parts).
- Rewrite `index.ts`. Simplify `repo.ts`, `stats.ts`, `config.ts`.
- Mới: `context.ts`, `review.ts`, `templates/review.gitlab-ci.yml`, `docs/CI_SETUP.md`.
- Dockerfile: bỏ `EXPOSE` + healthcheck, giữ builder multi-arch.
- README + AGENTS.md: cập nhật Decision Log (D1-revised), install guide.

### Decision Log update

- **D1 → D1-revised**: webhook service → GitLab CI job. Lý do đảo: pain points mục 1.
- D10 (ciwait), D11/D12 (inflight/unapprove) → **OBSOLETE** (CI native xử lý).
- D14 (SHA unify) → **OBSOLETE** (CI env var chính xác).

## 6. Image registry

**GHCR** (`ghcr.io/<org>/pi-reviewer-bot:latest`). Template `templates/review.gitlab-ci.yml`
pull từ GHCR. Lý do: repo hosted GitHub, public image đơn giản, user pull nhanh.
Multi-arch (amd64 + arm64) giữ nguyên qua `docker buildx`.

## 7. Risks & Rollback

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | User quên xóa webhook cũ → 2 review (webhook service cũ + CI job) chạy song song | Medium | Migration guide nêu rõ + log warn nếu phát hiện `WEBHOOK_SECRET` vẫn set |
| R2 | Job-fail block kéo dài nếu LLM provider outage | Medium | Intended (safe-default). User re-run pipeline khi provider hồi phục. Đổi provider qua `DEFAULT_MODEL` |
| R3 | `CI_MERGE_REQUEST_*` env var thiếu khi chạy ngoài MR context (main branch push) | Low | Template dùng `rules: if: $CI_PIPELINE_SOURCE == "merge_request_event"` — job skip, không lỗi |
| R4 | Review timeout nếu diff rất lớn | Low | GitLab CI default job timeout 1h đủ. Theo dõi, thêm `REVIEW_TIMEOUT_MS` nếu cần (YAGNI hiện tại) |
| R5 | GHCR rate-limit cho user pull nhiều | Low | Public image, rate-limit cao. Fallback: user self-host image |

**Rollback**: revert commit + deploy lại webhook service version cũ. Vì hard cutover,
không rollback trong cùng major version — rollback = quay về minor trước.

## 8. Success Criteria

- [ ] Bot chạy như CI job: pipeline MR pass → review job chạy → post summary + inline comments.
- [ ] Exit-code contract đúng: review error → job fail → MR blocked.
- [ ] `bun test` + `bun run typecheck` pass. Regression test cho `mrContextFromEnv()`.
- [ ] Migration guide (`docs/CI_SETUP.md`) đủ để user webhook cũ chuyển sang CI job.
- [ ] Image multi-arch publish lên GHCR, CI template pull được.
- [ ] Webhook-only code (webhook.ts, ciwait.ts, inflight.ts, limiter.ts) xóa hoàn toàn.
- [ ] Decision Log (AGENTS.md) cập nhật D1-revised + đánh dấu D10/D11/D12/D14 obsolete.

## 9. Decisions đã khóa (từ proposal question round)

| Quyết định | Giá trị | Lý do |
|---|---|---|
| Scope | CI-only (hard delete webhook) | Clean, đúng intent đảo D1. Dual-mode trái ý |
| Migration | Hard cutover + guide, major bump | Đơn giản nhất, không giữ code chết |
| Job-fail behavior | Block (safe default) | Không cho merge khi bot outage, user re-run |
| Image registry | GHCR | Repo GitHub-hosted, public, pull nhanh |

### Assumptions (my call, cần confirm ở spec/design)

- **stats sink**: stdout JSON line per review (CI log là consumer, bỏ HTTP `/stats`).
- **local debug**: giữ `LOCAL_REPO_PATH` + thêm CLI flag / env fallback cho chạy manual
  ngoài CI (reproduce review local). Chi tiết ở phase design.
- **timeout**: dùng GitLab CI default job timeout (1h). Không thêm `REVIEW_TIMEOUT_MS`
  lần đầu (YAGNI). Theo dõi, thêm khi warranted.
