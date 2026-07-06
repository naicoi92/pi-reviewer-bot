# CI Setup Guide (D1-revised: CI-job mode)

> Bot chạy như một **GitLab CI job** cuối pipeline — KHÔNG còn webhook server.
> Pipeline pass (`needs:`) → review job chạy → approve/request_changes MR.

## Tổng quan

```
MR push → pipeline (test → build → ...) all pass (needs:)
            → pi-review job (image bot) chạy review
            → bot approve / request_changes qua GitLab API
```

Bot cần **Project Access Token** (PAT) với quyền write (approve + comment) —
`CI_JOB_TOKEN` KHÔNG dùng được (chỉ đọc MR endpoints). Xem
[`AGENTS.md` Decision Log D1-revised](../AGENTS.md).

## Bước 1 — Tạo Project Access Token

```
Project → Settings → Access Tokens
  Name: pi-reviewer-bot
  Role: Developer (hoặc higher — cần quyền approve)
  Scopes: ✅ api
  → Create → copy token (glpat-...)
```

> Alternatives: **user PAT** (service account) cũng OK. Token này sẽ làm
> required approver, nên cần role ≥ Developer + thuộc Approval Rule.

## Bước 2 — Add bot làm required Approval Rule

```
Project → Settings → Merge requests → Approval rules
  Add rule:
    Name: Require bot review
    Approvals required: 1
    Approvers: @pi-reviewer-bot  (account sở hữu PAT ở bước 1)
```

Bot gọi `unapprove`/`approve` qua API → merge blocked cho đến khi bot approve.

## Bước 3 — Set CI/CD Variables

```
Project → Settings → CI/CD → Variables
  GITLAB_API_TOKEN = glpat-...        (PAT từ bước 1, masked + protected)
  ZAI_API_KEY = zai-...               (hoặc OPENAI_API_KEY/ANTHROPIC_API_KEY/...)
```

> Bot KHÔNG dùng `CI_JOB_TOKEN`. Có runtime guard: nếu `GITLAB_API_TOKEN ===
> CI_JOB_TOKEN` → job fail fast với message rõ.

## Bước 4 — Include CI template

Thêm vào `.gitlab-ci.yml` của project:

```yaml
include:
  - remote: '<github-raw-url>/templates/review.gitlab-ci.yml'
```

Hoặc copy nội dung `templates/review.gitlab-ci.yml` directly. Chỉnh `needs:` cho
khớp job names thực tế trong pipeline (vd `test`, `build`).

Template đặt job `pi-review` ở `stage: review`, `rules: merge_request_event`
(chỉ chạy trên MR), `GIT_STRATEGY: none` (bot dùng GitLab API, không checkout).

## Bước 5 — (Optional) Per-project config

Tạo `.pi/config.yaml` trong repo project:

```yaml
review:
  language: vi
  limits:                    # review execution limits
    maxToolCalls: 30         # default 30
    timeoutMs: 300000        # default 5 min
scope:
  enabled: true
  convention: "feat/T-XX-*"
  resolvesPattern: "Resolves: #(\\d+)"
  taskIndex: docs/design/07-roadmap.md
block:
  enabled: true              # block merge cho đến khi bot approve
llm:
  model: zai/glm-5.2         # per-project model override
```

> **Lưu ý**: `ci.*` (`ci.require`, `ci.waitTimeoutMs`) đã LOẠI BỎ — CI native lo
> wait qua `needs:`. Nếu config cũ còn `ci.*`, bot ignore + warn.

## Migrate từ webhook mode (breaking)

Project đang dùng webhook (pre-1.0):

1. **Xóa webhook** trong GitLab project settings (MR + Pipeline events).
2. **Thêm CI template** (bước 4) + set CI/CD Variables (bước 3).
3. **Bỏ `ci.*`** khỏi `.pi/config.yaml` (nếu có).
4. **Bỏ env cũ**: `WEBHOOK_SECRET`, `PORT`, `CI_WAIT_TIMEOUT_MS`,
   `MAX_CONCURRENT_REVIEWS`, `PER_PROJECT_COOLDOWN_MS`, `STATS_AUTH_TOKEN`.
5. **Purge env knobs → config.yaml**: `DEFAULT_MODEL` → `llm.model`,
   `MAX_TOOL_CALLS_PER_REVIEW` → `review.limits.maxToolCalls`,
   `REVIEW_TIMEOUT_MS` → `review.limits.timeoutMs`.

Bot deployment: bỏ Docker/K8s service (bot chạy ephemeral trong CI runner). Image
publish lên GHCR cho CI pull (`ghcr.io/naicoi92/pi-reviewer-bot:latest`).

## Exit-code contract

| Outcome | exit | MR |
|---|---|---|
| approved | 0 | unblocked |
| changes_requested | 0 | blocked (intentional — job vẫn pass) |
| inconclusive | 1 | blocked |
| error (LLM/network/timeout) | 1 | blocked |

Job fail (`exit 1`) = bot lỗi → MR blocked, user re-run pipeline. Đây là
**safe-default**, không phải bug.
