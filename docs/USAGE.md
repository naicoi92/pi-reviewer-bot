# Hướng dẫn sử dụng đầy đủ — pi-reviewer-bot

> Bot AI code review chạy như **GitLab CI job** cuối pipeline (D1-revised).
> Pipeline pass → review job chạy → bot approve/request_changes MR qua Pi Coding Agent.

## Mục lục

1. [Bot hoạt động thế nào](#1-bot-hoạt-động-thế-nào)
2. [Yêu cầu](#2-yêu-cầu)
3. [Setup (3 cách)](#3-setup)
4. [Cấu hình `.pi/config.yaml`](#4-cấu-hình)
5. [Luồng làm việc hàng ngày](#5-luồng-làm-việc-hàng-ngày)
6. [Đọc kết quả review](#6-đọc-kết-quả-review)
7. [Exit code + trạng thái MR](#7-exit-code--trạng-thái-mr)
8. [Troubleshooting](#8-troubleshooting)
9. [Migrate từ webhook mode](#9-migrate-từ-webhook-mode)
10. [FAQ](#10-faq)

---

## 1. Bot hoạt động thế nào

```
push branch → mở/cập nhật MR
   │
   ▼  pipeline chạy: lint → test → build → ... (các job khác)
   │  all pass (needs:)
   ▼
pi-review job (image bot, CI runner)
   ├─ Đọc context từ GitLab CI predefined env vars (CI_MERGE_REQUEST_*, CI_PROJECT_*)
   ├─ Load .pi/config.yaml (cwd)
   ├─ unapprove MR nếu block.enabled (revoke approval cũ)
   ├─ fetch diff qua GitLab API
   ├─ runPiReview: AI reviewer dùng 12 tools (fetch_file, web_search, post_inline_comment,
   │              post_summary, approve_mr / request_changes, ...)
   ├─ derive outcome từ toolState
   └─ exit code → MR state (exit 1 = MR blocked)
```

**Cốt lõi**: bot KHÔNG phải server online 24/7. Mỗi push = 1 pipeline mới = 1 review job
ephemeral. CI native `needs:` đảm bảo review chỉ chạy sau khi CI pass.

## 2. Yêu cầu

- **GitLab** (SaaS hoặc self-managed) có CI/CD runners.
- **LLM provider**: 1 API key bất kỳ Pi hỗ trợ (Z.ai / OpenAI / Anthropic / DeepSeek /
  Gemini / Ollama...). Recommend Z.ai ($12.6/mo flat).
- **Token** cho bot (Personal Access Token = mọi tier; Project Access Token = Premium+/Self-managed) — KHÔNG dùng `CI_JOB_TOKEN` (xem [§3.2](#32-tạo-token)).

## 3. Setup

### 3.1 Tổng quan

| Bước | Làm gì | Ở đâu |
|---|---|---|
| 1 | Tạo token (PAT mọi tier / Project Access Token Premium+) | Settings → Access Tokens |
| 2 | Merge gate (protected branch “Pipelines must succeed”) | Settings → Repository → Protected branches |
| 3 | Set CI/CD Variables (token + LLM key) | Project → Settings → CI/CD → Variables |
| 4 | Include CI template (Component hoặc raw) | `.gitlab-ci.yml` |
| 5 | (Optional) `.pi/config.yaml` | repo project |

### 3.2 Tạo token (bot identity)

Tier-aware (xem [CI_SETUP §1](CI_SETUP.md) chi tiết):

- **GitLab.com Free**: **Personal Access Token** (User Settings → Access Tokens,
  scope `api`) từ tài khoản bot/dịch vụ. Add user đó làm direct member project (Developer).
- **Premium+ / Self-Managed**: **Project Access Token** (Project → Settings → Access
  Tokens, Role Developer, scope `api`) — tự tạo bot user direct member.

> ⚠️ **`CI_JOB_TOKEN` KHÔNG dùng được** — chỉ đọc MR endpoints, không approve/note
> (fine-grained GA 18.3 restrict thêm). Runtime guard: `GITLAB_API_TOKEN === CI_JOB_TOKEN`
> → job fail ngay.

### 3.3 Merge gate (block merge đến khi bot pass)

**Cách 1 (mọi tier, KHUYẾN NGHỊ)** — protected branch “Pipelines must succeed”:

```
Project → Settings → Repository → Protected branches → main
  Allowed to merge: Maintainers
  ☑ Pipelines must succeed
```

`pi-review` exit 1 → pipeline fail → merge blocked. CI-native, không cần Approval Rule.

**Cách 2 (Premium+, tùy chọn)** — Approval Rule require bot
(xem [CI_SETUP §2](CI_SETUP.md)). Bot `unapprove`/`approve` qua API (`block.enabled: true`).

### 3.4 Set CI/CD Variables

```
Project → Settings → CI/CD → Variables
  GITLAB_API_TOKEN = glpat-...        (masked + protected)
  ZAI_API_KEY = zai-...               (hoặc OPENAI/ANTHROPIC/DEEPSEEK/...)
```

> Optional: `EXA_API_KEY` (web_search quality; fallback DuckDuckGo free).

### 3.5 Include CI template

**Option A — CI Component (preferred, cần GitLab catalog project):**

```yaml
include:
  - component: $CI_SERVER_FQDN/<gitlab-org>/pi-reviewer-bot/review@~1.0
    inputs:
      needs: [lint, test, build]   # default [test, build]
      stage: review                # default review
```

Component có `spec.inputs` (stage/needs/image) — không cần edit YAML, versioned qua
tags. **Caveat**: components chỉ reference trong cùng GitLab instance → bot (GitHub-hosted)
cần 1 GitLab project (mirror/catalog) để publish.

**Option B — Raw include (chạy được ngay từ GitHub):**

```yaml
include:
  - remote: '<github-raw-url>/templates/review.gitlab-ci.yml'
```

Hoặc copy nội dung `templates/review.gitlab-ci.yml` vào `.gitlab-ci.yml`. Chỉnh
`needs:` cho khớp job names pipeline của bạn.

Cả 2 đặt job `pi-review` ở `stage: review`, `rules: merge_request_event`
(chỉ chạy trên MR), `GIT_STRATEGY: none` (bot dùng GitLab API, không checkout).

### 3.6 (Optional) Local debug

```bash
# Mock CI env vars + token + LLM key, chạy CLI:
CI_MERGE_REQUEST_IID=42 CI_PROJECT_ID=100 CI_PROJECT_PATH=acme/demo \
  CI_PROJECT_URL=https://gitlab.com/acme/demo \
  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME=feat/x \
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME=main \
  CI_MERGE_REQUEST_SOURCE_BRANCH_SHA=abc123 \
  CI_API_V4_URL=https://gitlab.com/api/v4 \
  GITLAB_API_TOKEN=glpat-... ZAI_API_KEY=zai-... \
  bun src/index.ts
```

Xong setup. Mở MR → pipeline chạy → review job review.

---

## 4. Cấu hình

Tạo `.pi/config.yaml` trong repo project (optional — bot có default hợp lý):

```yaml
review:
  language: vi                              # ngôn ngữ comment: vi | en
  skipTitleRegex: "\\b(wip|dnr|do not review)\\b"   # skip MR có title match
  skipBranchRegex: "^(wip|scratch)/.*"      # skip branch match
  limits:                                   # review execution limits
    maxToolCalls: 30                        # default 30
    timeoutMs: 300000                       # default 5 min

scope:
  enabled: true                             # scope alignment check
  convention: "feat/T-XX-*"                 # branch pattern → task ID
  resolvesPattern: "Resolves: #(\\d+)"      # MR description → issue
  taskIndex: docs/design/07-roadmap.md      # file tra cứu task

block:
  enabled: true                             # block merge cho đến khi bot approve

llm:
  model: zai/glm-5.2                        # per-project model override
```

Xem schema đầy đủ: [`docs/CONFIG.md`](CONFIG.md).

> **Đã loại bỏ (D1-revised):** `ci.*` (`ci.require`, `ci.waitTimeoutMs`) — CI native
> lo wait qua `needs:`. Env knobs (`DEFAULT_MODEL`, `MAX_TOOL_CALLS_PER_REVIEW`,
> `REVIEW_TIMEOUT_MS`) đã chuyển sang config (`llm.model`, `review.limits.*`).

---

## 5. Luồng làm việc hàng ngày

1. **Tạo branch + commit** theo convention (vd `feat/T-42-login`).
2. **Mở MR** — description có `Resolves: #42` (nếu scope check bật).
3. **Push** → pipeline chạy (lint/test/build) → `pi-review` job chạy cuối.
4. **Bot review** (~30s-5 phút tùy diff): đọc diff, fetch_file verify context,
   web_search tra dep/CVE nếu cần, post inline comments + summary, ra verdict.
5. **Đọc comments** → fix → push commit mới → pipeline + review chạy lại.
6. **Bot approve** khi pass → MR unblock → merge.

### Re-trigger review

Push commit mới lên cùng branch → pipeline mới → review job chạy lại (review cũ
tự bị thay thế). Không cần webhook, không cần `@bot` command.

### Skip review (WIP/DNR)

- Title match `skipTitleRegex` (vd "WIP: ...") → bot skip, job pass.
- Branch match `skipBranchRegex` (vd `wip/*`) → bot skip.

---

## 6. Đọc kết quả review

Bot post 2 loại comment:

### 6.1 Summary note (top-level verdict)

```markdown
## ✅ Approved (hoặc ⚠️ Changes Requested)

**Tóm tắt:** ...verdict markdown...
```

Bắt buộc trước khi approve (guardrail).

### 6.2 Inline DiffNote (line-specific)

Trên từng dòng/hunk có issue, kèm **severity**:

- 🔴 **critical** — phải fix trước approve (block approve_mr).
- 🟡 **warning** — nên fix.
- 🔵 **nitpick** — gợi ý, optional.

### Verdict outcomes

| Verdict | Ý nghĩa | MR |
|---|---|---|
| ✅ Approved | Bot gọi `approve_mr` | unblocked |
| ⚠️ Changes Requested | Bot gọi `request_changes` | blocked (intentional) |
| ⚠️ Inconclusive | Bot chạy xong nhưng chưa ra verdict | blocked |
| 🤖 Review failed | Lỗi (LLM/network/timeout) | blocked |

---

## 7. Exit code + trạng thái MR

| Outcome | exit | Job | MR |
|---|---|---|---|
| approved | 0 | ✅ pass | unblocked |
| changes_requested | 0 | ✅ pass | blocked (intentional) |
| inconclusive | 1 | ❌ fail | blocked |
| error | 1 | ❌ fail | blocked |
| skipped (WIP/no diff) | 0 | ✅ pass | unchanged |

**Quan trọng**: job fail (`exit 1`) = bot lỗi → MR blocked, user re-run pipeline.
Đây là **safe-default**, không phải bug — không cho merge khi bot outage.

---

## 8. Troubleshooting

### Job fail: `GITLAB_API_TOKEN === CI_JOB_TOKEN`

Token sai. Dùng Project Access Token / user PAT (scope api), KHÔNG `CI_JOB_TOKEN`.

### Job fail: `Missing or invalid CI env var: CI_MERGE_REQUEST_IID`

Job chạy ngoài MR context. Kiểm tra `rules: if: $CI_PIPELINE_SOURCE == "merge_request_event"`
có trong template. Push main/tag → job skip (đúng), không lỗi.

### Bot không review / job skip

- `skipTitleRegex`/`skipBranchRegex` match → check title/branch.
- `needs:` chưa pass → job đợi (hoặc skip nếu job depend fail).

### Review inconclusive (bot không ra verdict)

- Diff quá lớn + AI hết tool calls → tăng `review.limits.maxToolCalls`.
- Model yếu → đổi `llm.model` (vd `anthropic/claude-3.5-sonnet`).
- Timeout → tăng `review.limits.timeoutMs`.

### LLM provider error (timeout/401)

- Sai API key → check CI/CD Variable.
- Provider outage → đổi provider qua `llm.model` + key tương ứng.
- Rate limit → bot retry trên pipeline kế tiếp.

### Inline comment không hiện đúng line

Bot validate line qua GitLab API position hash. Nếu rebase làm diff shift → push lại.

### Config parse warn trong log

`.pi/config.yaml` YAML sai syntax → bot dùng default + warn. Fix cú pháp YAML.

---

## 9. Migrate từ webhook mode

Project đang dùng webhook (pre-1.0):

1. **Xóa webhook** trong Project Settings → Webhooks (MR + Pipeline events).
2. **Add CI template** (§3.5) + set CI/CD Variables (§3.4) + merge gate (§3.3).
3. **Bỏ `ci.*`** khỏi `.pi/config.yaml` (nếu có) — bot ignore + warn.
4. **Bỏ env cũ** (nếu set): `WEBHOOK_SECRET`, `PORT`, `CI_WAIT_TIMEOUT_MS`,
   `MAX_CONCURRENT_REVIEWS`, `PER_PROJECT_COOLDOWN_MS`, `STATS_AUTH_TOKEN`.
5. **Purge env knobs → config**: `DEFAULT_MODEL`→`llm.model`,
   `MAX_TOOL_CALLS_PER_REVIEW`→`review.limits.maxToolCalls`,
   `REVIEW_TIMEOUT_MS`→`review.limits.timeoutMs`.

Bot deployment cũ (Docker/K8s service): bỏ — bot giờ chạy ephemeral trong CI runner.
Image publish lên GHCR cho CI pull.

---

## 10. FAQ

**Q: Bot có cần online 24/7 không?**
Không. Bot là CI job ephemeral — chạy khi pipeline trigger, exit khi xong.

**Q: Nhiều project dùng chung 1 bot?**
Mỗi project add CI template + set CI/CD Variables riêng. Không cần central bot server.
Mỗi project tự control token/LLM key/config.

**Q: Bot review branch mà CI chưa pass?**
Không. `needs:` đảm bảo job review chỉ chạy sau khi các job trong needs pass. Muốn
review ngay (bỏ qua CI) → bỏ `needs:` (không recommend — lãng phí token review code CI sẽ catch).

**Q: Đổi LLM provider per-project?**
Set `llm.model` trong `.pi/config.yaml` (vd `openai/gpt-4o`) + key tương ứng trong CI/CD Variables.

**Q: Bot tự review chính repo pi-reviewer-bot?**
Có (dogfood) — add template vào `.gitlab-ci.yml` của bot repo + set vars.

**Q: Self-hosted GitLab?**
Bot derive `GITLAB_URL` từ `CI_API_V4_URL` tự động. Token vẫn cần PAT (CI_JOB_TOKEN không đủ).

**Q: Component vs raw include — chọn nào?**
Component (versioning/inputs/catalog) nếu có GitLab catalog project. Raw include nếu
GitHub-hosted hoặc muốn đơn giản. Xem [§3.5](#35-include-ci-template).
