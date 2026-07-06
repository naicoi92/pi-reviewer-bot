# CI Setup Guide (D1-revised: CI-job mode)

> Bot chạy như **GitLab CI job** cuối pipeline. Pipeline pass → review → bot
> approve/request_changes qua GitLab API. KHÔNG còn webhook server.

## Tier note (quan trọng)

| Nơi | Project Access Token | Approval Rules | Personal Access Token |
|---|---|---|---|
| **GitLab.com Free** | ❌ KHÔNG (Premium+) | ❌ KHÔNG (Premium+) | ✅ |
| **GitLab.com Premium/Ultimate** | ✅ | ✅ | ✅ |
| **Self-Managed / Dedicated** (licensing này) | ✅ | ✅ (cần Premium license) | ✅ |

→ **GitLab.com Free**: dùng **Personal Access Token** + gate qua **protected branch
"Pipelines must succeed"** (xem §2, §3). Bot vẫn chạy đầy đủ, chỉ gate khác.

---

## 1. Token (bot identity)

Bot cần token có quyền **write** (approve + comment). `CI_JOB_TOKEN` **KHÔNG dùng được**
(chỉ đọc MR endpoints — confirmed; fine-grained GA 18.3 restrict thêm, không thêm MR).
Runtime guard: `GITLAB_API_TOKEN === CI_JOB_TOKEN` → job fail ngay.

### Option A — Personal Access Token (mọi tier, incl. Free) — khuyến nghị

Tạo từ 1 tài khoản bot/dịch vụ (hoặc tài khoản cá nhân nếu solo):

```
User Settings (avatar) → Access Tokens
  Name: pi-reviewer-bot
  Scopes: ✅ api
  → Create → copy glpat-...
```

Add user đó làm **direct member** của project, role **Developer** (Project → Manage →
Members). Direct member Developer+ → eligible approver.

### Option B — Project Access Token (Premium+ / Self-Managed)

```
Project → Settings → Access Tokens
  Name: pi-reviewer-bot
  Role: Developer
  Scopes: ✅ api
  → Create → copy glpat-...
```

Tự tạo **bot user** làm direct member của project (Developer). Username:
`project_{id}_bot_{random}`.

> Token có hạn (default 365 ngày). Set reminder rotate, hoặc dùng CI/CD variable rotate.

---

## 2. Merge gate (block merge đến khi bot pass)

### Cách 1 — Protected branch "Pipelines must succeed" (mọi tier — KHUYẾN NGHỊ)

Đây là gate CI-native, hoạt động mọi tier (Free+). Không cần Approval Rule:

```
Project → Settings → Repository → Protected branches
  Chọn branch (vd main):
    Allowed to merge: Maintainers
    ☑ Pipelines must succeed     ← CHỐT: pipeline fail = không merge được
```

Vì `pi-review` nằm trong pipeline, bot `exit 1` (review inconclusive/error) → pipeline
fail → merge blocked. Bot `exit 0` (approved/changes) → pipeline pass. Exit-code contract
ánh xạ trực tiếp sang gate này.

### Cách 2 — Approval Rule require bot (Premium+ — tùy chọn, thêm lớp)

Nếu muốn bot **explicitly approve** (thêm green check từ bot), ngoài status check:

```
Project → Settings → Merge requests → Merge request approvals → Approval rules
  Add approval rule:
    Name: Require bot review
    Approvals required: 1
    Approvers: <bot user>   (PAT bot user hoặc service account từ §1)
```

Bot gọi `unapprove`/`approve` qua API (`block.enabled: true` trong config). MR blocked
đến khi bot approve.

> Free tier: bỏ qua cách 2 (chỉ có approval count, không require specific approver).
> Dùng cách 1 (status check) — đủ block.

---

## 3. Set CI/CD Variables

```
Project → Settings → CI/CD → Variables
  GITLAB_API_TOKEN = glpat-...        (token từ §1, masked + protected)
  ZAI_API_KEY = zai-...               (hoặc OPENAI/ANTHROPIC/DEEPSEEK/...)
```

Optional: `EXA_API_KEY` (web_search quality; fallback DuckDuckGo free).

---

## 4. Include CI template

### Option A — CI Component (preferred, cần GitLab catalog project)

```yaml
include:
  - component: $CI_SERVER_FQDN/<gitlab-org>/pi-reviewer-bot/review@~1.0
    inputs:
      needs: [lint, test, build]   # default [test, build]
      stage: review                # default review
```

Component (`templates/review.yml`) có `spec.inputs` — versioned qua tags. **Caveat**:
components chỉ reference trong **cùng GitLab instance** → bot (GitHub-hosted) cần 1
GitLab project (mirror/catalog) để publish.

### Option B — Raw include (GitHub-hosted, chạy ngay)

```yaml
include:
  - remote: '<github-raw-url>/templates/review.gitlab-ci.yml'
```

Hoặc copy `templates/review.gitlab-ci.yml` vào `.gitlab-ci.yml`. Chỉnh `needs:` cho khớp
job names pipeline của bạn.

Cả 2: job `pi-review` ở `stage: review`, `rules: merge_request_event` (chỉ MR),
`GIT_STRATEGY: none` (bot dùng GitLab API, không checkout).

---

## 5. (Optional) Per-project config

`.pi/config.yaml` trong repo project:

```yaml
review:
  language: vi
  limits: { maxToolCalls: 30, timeoutMs: 300000 }
block:
  enabled: true              # bot unapprove/approve (cách 2, Premium+)
llm:
  model: zai/glm-5.2
```

> `ci.*` đã LOẠI BỎ — CI native lo wait. Env knobs (`DEFAULT_MODEL`/
> `MAX_TOOL_CALLS_PER_REVIEW`/`REVIEW_TIMEOUT_MS`) đã chuyển sang config.

---

## 6. Migrate từ webhook mode (pre-1.0)

1. **Xóa webhook** (Project Settings → Webhooks: MR + Pipeline events).
2. **Token**: giữ PAT/Project Access Token (§1) — set CI/CD Variable `GITLAB_API_TOKEN`.
3. **Gate**: protected branch "Pipelines must succeed" (§2 cách 1) thay webhook approval.
4. **Include template** (§4) + LLM key (§3).
5. **Bỏ `ci.*`** khỏi `.pi/config.yaml`; purge env knobs → config (§5).
6. **Bỏ env cũ**: `WEBHOOK_SECRET`, `PORT`, `CI_WAIT_TIMEOUT_MS`, `MAX_CONCURRENT_REVIEWS`,
   `PER_PROJECT_COOLDOWN_MS`, `STATS_AUTH_TOKEN`.
7. Bỏ bot Docker/K8s service — bot chạy ephemeral trong CI runner. Image trên GHCR.

---

## 7. Exit-code contract

| Outcome | exit | Gate effect (cách 1 status check) |
|---|---|---|
| approved / changes_requested | 0 | pipeline pass → mergeable |
| inconclusive / error | 1 | pipeline fail → **merge blocked** |
| skipped (WIP/no diff) | 0 | pipeline pass |

Job fail (`exit 1`) = bot lỗi → MR blocked, user re-run pipeline. **Safe-default**, không phải bug.

---

## 8. Troubleshooting

### "Settings → Access Tokens" không có / không tạo được Project Access Token

→ Bạn ở **GitLab.com Free**. Dùng **Personal Access Token** (§1 Option A) từ user account.

### Không thấy "Approval rules" / không add được

→ Approval Rules = **Premium+**. Dùng gate **cách 1** (protected branch "Pipelines must
succeed") — hoạt động Free+, đủ block merge.

### Job fail: `GITLAB_API_TOKEN === CI_JOB_TOKEN`

Token sai. Dùng PAT/Project Access Token (scope api), KHÔNG `CI_JOB_TOKEN`.

### Job fail: `Missing CI env var: CI_MERGE_REQUEST_IID`

Job chạy ngoài MR context. Template phải có `rules: if: $CI_PIPELINE_SOURCE == "merge_request_event"`.

### Bot approve rồi nhưng MR vẫn blocked

- Protected branch "Pipelines must succeed" đang ON + pipeline fail (do job khác) → fix CI.
- Approval Rule require bot nhưng bot user chưa là direct member Developer+ → check Members.
- "Reset approvals on push" + bot chưa re-approve pipeline mới → đợi review job chạy.

### Review inconclusive

- Tăng `review.limits.maxToolCalls` / `timeoutMs`.
- Đổi `llm.model` (model mạnh hơn).
- Check LLM key đúng provider.

### Config parse warn

`.pi/config.yaml` YAML sai syntax → bot dùng default + warn. Fix cú pháp.
