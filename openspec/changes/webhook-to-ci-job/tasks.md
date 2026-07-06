# Tasks: webhook-to-ci-job

> Implementation tasks từ `proposal.md` + `specs/review-job/spec.md` + `design.md`.
> Strict TDD (config.yaml): logic tasks = RED → GREEN → TRIANGULATE → REFACTOR.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1200 (additions ~600 + deletions ~600) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes (but coupling-limited — xem note) |
| Suggested split | PR1: core rewrite + removal (atomic) → PR2: docs/Dockerfile/template polish |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High
```

**Note split:** `config.ts` + `repo.ts` shared giữa webhook code (cũ) và CI path (mới) →
khó tách "additive PR1 + removal PR2" sạch (sửa `repo.ts`/`config.ts` break compile
webhook.ts). Đề xuất: **PR1 = core rewrite + removal atomic** (compile green cuối),
**PR2 = docs/Dockerfile/template** (low-risk polish). Hoặc single-PR với commit atomic
per-layer nếu user chấp nhận review lớn.

---

## Group 1 — Config + Context (foundation, TDD)

- [ ] **1.1** `src/config.ts`: xóa `CiConfig` + field `ci?`; thêm `ReviewLimits` (`maxToolCalls`, `timeoutMs`, default `{30, 300000}`) vào `ReviewConfig`; `mergeConfig` parse `review.limits` + warn `ci.*` legacy. **RED** `test/config.test.ts`: parse limits đúng, ci.* ignored+warn, default values. **GREEN** impl.
- [ ] **1.2** `src/context.ts` (MỚI): `mrContextFromEnv(env=process.env): MrContext` + `ContextError`. **RED** `test/context.test.ts`: đủ env→ok, thiếu từng var→throw, repoDir `LOCAL_REPO_PATH` fallback. **GREEN** impl.

## Group 2 — Repo + Review core

- [ ] **2.1** `src/repo.ts`: xóa `cloneForReview`, `shortSha`, `ClonedRepo`; export `repoDir = process.env.LOCAL_REPO_PATH ?? process.cwd()`. Giữ `readFileOrNull`.
- [ ] **2.2** `src/review.ts` (MỚI): port `performReview` từ `webhook.ts:143-316` sang `(ctx: MrContext, cfg: ProjectConfig): Promise<ReviewOutcome>`. Strip ciwait/limiter/clone. Wrap try/catch→`ReviewOutcome`. **RED** `test/review.test.ts` (rewrite từ `webhook.test.ts`): approve→ok:0, request_changes→ok:0, inconclusive→fail, exception→fail (mock gitlab/pi). **GREEN** impl.

## Group 3 — Supporting changes

- [ ] **3.1** `src/pi.ts`: `runPiReview` đọc `cfg.llm.model` + `cfg.review.limits.timeoutMs` qua opts thay vì `process.env.DEFAULT_MODEL`/`REVIEW_TIMEOUT_MS`. Xóa 2 module-level env const.
- [ ] **3.2** `src/tools/index.ts`: `MAX_TOOL_CALLS` đọc từ tool state (`cfg.review.limits.maxToolCalls`) thay vì `process.env`.
- [ ] **3.3** `src/stats.ts`: bỏ HTTP `/stats`; thêm `emitStatsLine(ctx, outcome, durationMs)` stdout JSON (project, mrIid, sourceSha, outcome, durationMs, timestamp).

## Group 4 — Entry + Removal (atomic — compile green cuối)

> Group 2+3 break compile webhook.ts (dùng cloneForReview/CiConfig). Group 4 phải land
> cùng để tree compile green.

- [ ] **4.1** `src/index.ts`: rewrite Hono server → CLI (`mrContextFromEnv` + auth guard `GITLAB_TOKEN===CI_JOB_TOKEN`→exit 1 + WEBHOOK_SECRET warn + `performReview` + `emitStatsLine` + exit code).
- [ ] **4.2** **XÓA** `src/webhook.ts`, `src/ciwait.ts`, `src/inflight.ts`, `src/limiter.ts`.
- [ ] **4.3** `src/types.ts`: xóa `MergeRequestWebhook`, `Pipeline` (webhook payload). Giữ `MrContext`.
- [ ] **4.4** Verify compile: `bun run typecheck` pass (không còn import webhook/ciwait/inflight/limiter).

## Group 5 — Packaging

- [ ] **5.1** `templates/review.gitlab-ci.yml` (MỚI): job `pi-review` (stage review, image GHCR, needs test/build, rules merge_request_event, GIT_STRATEGY none).
- [ ] **5.2** `Dockerfile`: bỏ `EXPOSE 3000` + `HEALTHCHECK`. Giữ multi-stage Bun --compile + Alpine.
- [ ] **5.3** `package.json`: bump major; bỏ dep `hono` (verify không dùng chỗ khác).

## Group 6 — Docs

- [ ] **6.1** `docs/CI_SETUP.md` (MỚI): tạo Project Access Token (scope api, role approver) + add Approval Rule + set `GITLAB_TOKEN` CI/CD var + include template + drop webhook + drop `ci.*` config.
- [ ] **6.2** `README.md`: cập nhật install/quickstart (CI job mode, không còn webhook server).
- [ ] **6.3** `AGENTS.md`: Decision Log — D1→D1-revised; mark D10/D11/D12/D14 OBSOLETE; update Repo Layout (xóa webhook/ciwait/inflight/limiter, thêm context/review/templates); update env table (purge knobs).

## Group 7 — Verify

- [ ] **7.1** `bun test` pass (context/review/config tests green, tools/ssrf giữ).
- [ ] **7.2** `bun run typecheck` pass.
- [ ] **7.3** (optional) Dogfood: pi-reviewer-bot review chính nó qua CI job trên MR mẫu.

---

## Notes

- **TDD scope**: Group 1.1, 1.2, 2.2 = RED-GREEN (logic). Còn lại = mechanical/edit, verify qua typecheck+test chung.
- **Compile coupling**: Group 2+3+4 land cùng (atomic commit). Group 1, 5, 6 độc lập.
- **Decision carry-over**: chained PR vs single-PR — resolve trước apply (Group 4 là unit lớn nhất).
