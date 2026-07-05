# Integration Guide — Setup pi-reviewer-bot cho project của bạn

> **Audience**: Project owner / AI agent (Claude Code, Cursor, Pi, Codex) đang làm việc trong
> **repo GitLab khác** và muốn enable AI code review cho repo đó.
>
> Doc này hướng dẫn từng bước để tích hợp pi-reviewer-bot vào project —
> **không phải setup bản thân bot service**. Nếu bạn cần deploy bot, xem
> [SETUP.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/SETUP.md) trước, rồi quay lại đây.
>
> 🤖 **AI agent? Đọc thêm [SKILLS.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/SKILLS.md)** — luồng công việc hàng ngày
> với bot: tạo MR, đợi review, xử lý feedback, re-trigger khi cần, debug "bot im lặng".

## TL;DR — 3 bước

```bash
# 1. Tạo config trong repo
mkdir -p .pi/agents
cat > .pi/config.yaml <<EOF
review:
  language: vi
scope:
  enabled: false    # bật true nếu project có task convention
block:
  enabled: false    # bật true nếu muốn block merge
EOF

# 2. (Optional) Add project review rules
curl -o .pi/REVIEW_RULES.md \
  https://raw.githubusercontent.com/naicoi92/pi-reviewer-bot/main/agents/REVIEW_RULES.template.md

# 3. Add webhook trong GitLab
# Settings → Webhook → URL: https://pi-bot.example.com/webhook → Secret: ...
```

Xong. Mở MR → bot tự review trong ~30s-3 phút.

---

## Yêu cầu từ phía project

Trước khi tích hợp, đảm bảo project có:

| Yêu cầu | Cách kiểm tra |
|---|---|
| **Repo hosted trên GitLab** (gitlab.com hoặc self-managed) | `git remote -v` có `gitlab.com` |
| **Bot PAT là member của project** (role Developer+) | Project → Members → có bot account |
| **Webhook URL truy cập được từ GitLab** | Bot service đã deploy (xem [SETUP.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/SETUP.md)) |
| **`AGENTS.md` ở repo root** (khuyến nghị) | `ls AGENTS.md` — Pi tự đọc để hiểu conventions |

---

## Bước 1 — Tạo `.pi/config.yaml` trong repo

File này optional nhưng nên có để customize behavior. Tạo ở repo root:

```yaml
# .pi/config.yaml — pi-reviewer-bot project config
# Full schema: https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/CONFIG.md

review:
  # Ngôn ngữ comment: vi | en
  language: vi

  # Regex (JS, không dùng (?i)) — match title → skip review
  skipTitleRegex: "\\b(wip|dnr|do not review)\\b"

  # Match source branch → skip review
  skipBranchRegex: "^(wip|scratch|dependabot)/.*"

scope:
  # Scope Alignment Check — bot verify MR có giải quyết task không
  enabled: false

  # Nếu project có task convention (vd T-XX), bật scope:
  # enabled: true
  # convention: "feat/T-XX-*"               # branch pattern → task ID
  # resolvesPattern: "Resolves: #(\\d+)"    # MR description → issue link
  # taskIndex: docs/design/07-roadmap.md    # file tra cứu task definition

block:
  # Block merge cho đến khi bot approve
  # PHẢI kết hợp GitLab Approval Rule (xem bước 4) để thực sự block
  enabled: false

llm:
  # Override model default của bot service
  # model: zai/glm-5.2
```

Commit file này vào **main branch** của project. Bot clone source branch của MR
và đọc file từ đó → cần có sẵn trước khi review.

---

## Bước 2 — (Optional) Add project review rules

Bot tự có sẵn **system prompt gốc** (cách dùng 12 tools, workflow, severity rules,
web lookup guidance, ...). Project KHÔNG cần copy phần này — bot upgrade tools →
project auto kế thừa.

Để customize review cho project của bạn, tạo `.pi/REVIEW_RULES.md` — chỉ chứa
info về **project của bạn** (stack, conventions, scope rules, license policy).

```bash
mkdir -p .pi
# Copy template (optional — viết tay cũng OK)
curl -o .pi/REVIEW_RULES.md \
  https://raw.githubusercontent.com/naicoi92/pi-reviewer-bot/main/agents/REVIEW_RULES.template.md
```

```markdown
<!-- .pi/REVIEW_RULES.md -->

# Review Rules — <tên project>

## Stack
- Rust 1.75+ strict mode (no unwrap() ngoài test)
- TypeScript strict no-`any` cho frontend

## Review focus (theo layer)
- src-tauri/**/*.rs: async correctness, ownership, Result/Option
- src/**/*.{ts,tsx}: reactivity patterns, accessibility

## Policies
- Không dùng GPL/LGPL crate
- Domain layer (src/domain/) không import infra deps

## Out of scope
- Không review docs/design/** (design docs)
- Skip vendor/** (third-party)
```

Section nào không cần → bỏ. Template đầy đủ xem [`agents/REVIEW_RULES.template.md`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/agents/REVIEW_RULES.template.md).

**Quan trọng**: `.pi/REVIEW_RULES.md` quyết định **chất lượng review cho project của bạn**.
Viết càng cụ thể, bot càng chính xác. Không có file này → bot vẫn review được với
default (generic, không biết conventions đặc thù).

> 💡 **Bot-controlled vs project-controlled**: phần hướng dẫn tools/workflow do bot
> lo. Project chỉ viết về project của mình. Khi bot thêm tool mới (vd web_search),
> project tự động có tool đó — không cần update prompt.

---

## Bước 3 — Tạo `AGENTS.md` (nếu chưa có)

Pi auto-load `AGENTS.md` ở repo root để hiểu project context. Đây là file chuẩn
cho mọi AI agent (Pi, Codex, Cursor, Claude Code).

Template tối thiểu:

```markdown
# <tên project> — Project Context

## Overview
<mô tả project 2-3 câu>

## Tech Stack
- Backend: <vd Rust + Tauri 2>
- Frontend: <vd SolidJS + TypeScript>
- DB: <vd SQLite + sqlx>

## Module Layout
<vd>
crates/domain/         — pure domain, no infra deps
crates/application/    — use cases, port traits
crates/infra-*/        — adapter implementations
src/                   — frontend

## Conventions
- TypeScript strict, no `any`
- Rust: no unwrap() in production
- Tests required for new features
- Commit format: conventional commits

## Useful Commands
- `pnpm test` — run tests
- `cargo clippy -- -D warnings` — lint
- `pnpm tauri dev` — dev server
```

---

## Bước 4 — Add GitLab webhook

```
Project → Settings → Webhook
```

| Trường | Giá trị |
|---|---|
| **URL** | `https://<bot-host>/webhook` (hỏi admin pi-reviewer-bot) |
| **Secret token** | `<WEBHOOK_SECRET>` (cùng giá trị set trong bot env) |
| **Trigger** | ✅ **Merge request events** (bắt buộc) |
|  | ✅ **Pipeline events** (chỉ khi dùng `ci.require: true` ở Bước 6) |
| **SSL verification** | ✅ Enable |

Click **Add webhook** → **Test → Merge request events** để verify.

---

## Bước 5 (tùy chọn) — Enable merge gate

Muốn MR bị block cho đến khi bot approve:

1. Project-side: `.pi/config.yaml` set `block.enabled: true`
2. GitLab: Settings → Merge requests → Approval rules → Add rule:
   - Name: `AI Review (pi-bot)`
   - Approvals required: `1`
   - Approvers: `<bot-account>`

Workflow khi enable:
```
MR mở         → bot chưa review → 0/1 approval → BLOCKED
Bot review    → verdict APPROVE → 1/1 approval → UNBLOCKED ✅
              → verdict REQUEST_CHANGES → 0/1 → BLOCKED 🚫
Push commit   → GitLab reset approval → BLOCKED → bot re-review
```

User vẫn có thể manually approve để override khẩn cấp.

---

## Bước 6 (tùy chọn) — Enable CI wait mode

Muốn bot **chỉ review khi CI pass** (pipeline success)? Bật CI wait mode:

### Khi nào nên bật?

- ✅ Project có CI chạy lint+test → tránh review code mà CI sẽ catch lỗi
- ✅ Project nhiều contributor → giảm noise false-positive trên code chưa chạy được
- ❌ Project chưa setup CI → bot vẫn review luôn (lenient default)
- ❌ Project docs-only → CI không có ý nghĩa

### Setup

**1. Project phải có `.gitlab-ci.yml`** chạy ít nhất 1 job (test/lint). Bot check pipeline status qua GitLab API.

**2. `.pi/config.yaml`:**

```yaml
ci:
  require: true
  # waitTimeoutMs: 900000   # 15 phút — chỉ set nếu CI chậm (E2E, monorepo)
```

**3. GitLab webhook phải enable thêm Pipeline events:**

```
Project → Settings → Webhook → edit webhook có sẵn
  Trigger: ✅ Merge request events (đã có)
           ✅ Pipeline events (BẬT THÊM)
```

> ⚠️ Quên enable "Pipeline events" → bot enqueue pending nhưng không nhận được signal CI finish → review chỉ chạy sau timeout (10 phút default).

### Workflow

```
1. Dev mở MR → GitLab gửi MR webhook tới bot
2. Bot clone + load .pi/config.yaml + check pipeline status:
   ├── CI running → post "⏸ Đợi CI pass" + enqueue pending
   │   ↓ (sau vài phút)
   │   CI pass → GitLab gửi pipeline webhook (status=success)
   │   ↓
   │   Bot trigger review tự động
   ├── CI failed → post "🚫 CI failed" + DONE
   ├── CI pass → review luôn
   └── no pipeline → review luôn (lenient)
3. Bot review + post comments + approve/request_changes
```

### Edge cases

| Case | Behavior |
|---|---|
| CI chạy >timeout (default 10 phút) | Bot proceed review anyway + log |
| Bot restart giữa lúc đang đợi CI | Pending lost → push commit để retry |
| Re-push commit | Entry mới override entry cũ (per-SHA) |
| Project chưa setup CI | Bot review luôn (không block) |

### Timeout — per-project override

Mặc định bot service set `CI_WAIT_TIMEOUT_MS=600000` (10 phút). Project CI chậm có thể override:

```yaml
ci:
  require: true
  waitTimeoutMs: 1_800_000   # 30 phút — cho monorepo có E2E
```

Xem [`docs/CONFIG.md#ci-integration`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/CONFIG.md#ci-integration) cho full schema + priority chain.

---

## Workflow review từ góc nhìn project

```
1. Dev mở MR (branch feat/T-XX-*)
   ↓
2. GitLab gửi webhook tới bot
   ↓
3. Bot clone source branch (depth 1)
   ↓
4. Bot đọc .pi/config.yaml + .pi/REVIEW_RULES.md + AGENTS.md
   ↓
5. (Nếu ci.require=true) Bot check pipeline status:
   ├── CI running → đợi pipeline webhook → trigger review khi CI pass
   ├── CI failed → post note + DONE
   └── CI pass / no pipeline → review luôn
   ↓
6. Bot spawn Pi Coding Agent với GLM-5.2:
   - AI dùng 10 tools để review
   - fetch_file khi cần context
   - get_issue(iid) nếu Resolves: #N
   - list_mr_comments() nếu re-review
   - post_inline_comment(path, line, comment, severity)
   - post_summary(markdown)
   - approve_mr(rationale) HOẶC request_changes(reason)
   ↓
7. Comment xuất hiện trong MR sau ~30s-3 phút (sau khi CI pass)
```

---

## Tuỳ biến theo loại project

### Project solo, không task convention

```yaml
# .pi/config.yaml — minimal
review:
  language: en  # hoặc vi
```

Bot review technical correctness, không scope check.

### Project có ADRs + task convention

```yaml
review:
  language: vi

scope:
  enabled: true
  convention: "feat/T-XX-*"
  resolvesPattern: "Resolves: #(\\d+)"
  taskIndex: docs/design/07-roadmap.md

block:
  enabled: true
```

Bot verify MR có đúng task, module boundary, acceptance criteria.

### Monorepo

```yaml
review:
  language: en
  skipBranchRegex: "^(wip|scratch|dependabot)/.*"

# Monorepo thường không có task convention global
scope:
  enabled: false
```

Mỗi package có thể có `.pi/REVIEW_RULES.md` riêng (nếu muốn).

### Project docs-only

```yaml
review:
  language: en

# Scope check không cần — docs không có task
scope:
  enabled: false

# Block enabled=false — docs không cần gate khắt khe
block:
  enabled: false
```

Agent prompt cho docs-only:

```markdown
# Code Reviewer — Docs Project
Review markdown content: spelling, grammar, link validity, code-block correctness.
No security/performance checks needed.
```

---

## Trigger review thủ công

Nếu MR đã mở trước khi setup webhook, có 2 cách trigger:

### Cách A — Push commit mới

```bash
git commit --allow-empty -m "trigger: pi-review"
git push
```

Bot sẽ nhận webhook `update` event và review.

### Cách B — Reopen MR

```
GitLab MR → Close → Reopen
```

Trigger `reopen` action được bot handle như `open`.

---

## Verify setup hoạt động

### Test 1 — Webhook nhận được

```
GitLab → Project → Settings → Webhook → Test → Merge request events
```

Bot log sẽ thấy:
```
[webhook] skip !XX — reason=action=test  (hoặc accepted nếu MR thật)
```

### Test 2 — Review xuất hiện

Tạo branch test:

```bash
git checkout -b test/pi-bot-smoke
echo "<!-- pi-bot smoke test -->" >> README.md
git add . && git commit -m "test: smoke test pi-bot"
git push origin test/pi-bot-smoke
```

Mở MR. Bot review trong ~30s-3 phút. Verify:
- ✅ Comment "🤖 Review (Pi + GLM-5.2)" xuất hiện
- ✅ Inline line comments (nếu có issue)
- ✅ Verdict section

### Test 3 — Scope Alignment (nếu bật)

Tạo MR có `Resolves: #1` + branch `feat/T-11-test`:

```
Bot comment phải có scope alignment output:
"📋 Scope: T-11 [✅] | Boundary [✅] | Criteria X/Y"
```

---

## Troubleshooting từ phía project

### Bot không review

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| Webhook Test 200 nhưng không review | MR có draft=true | Unmark draft trong GitLab |
| Webhook Test 401 | WEBHOOK_SECRET sai | Check với admin bot service |
| Review comment thiếu | Bot PAT không phải member | Project → Members → invite bot |
| Skip review | Title chứa "wip"/"dnr" | Đổi title |
| Bot đợi hoài không review (CI wait mode) | Quên enable "Pipeline events" webhook | Project → Webhook → tick thêm Pipeline events |
| CI pass nhưng bot không review | `ci.require: false` (chưa bật CI wait) | Set `ci.require: true` trong `.pi/config.yaml` |
| Review bị skip sau CI fail | Pipeline status = failed/canceled | Fix CI rồi push commit mới |

### Review chất lượng kém

| Triệu chứng | Fix |
|---|---|
| Bot review generic, không biết conventions | Viết `.pi/REVIEW_RULES.md` cụ thể hơn |
| Bot không biết task convention | Bật `scope.enabled` trong `.pi/config.yaml` |
| Bot comment tiếng Anh dù muốn VN | Set `review.language: vi` |
| Bot không đọc được ADRs | Đảm bảo file trong repo HOẶC dùng `get_wiki_page` tool |

### Bot approve nhầm / request_changes nhầm

- Bot có guardrail: phải `post_summary` trước + 0 critical mới approve
- Nếu verdict sai → review `.pi/REVIEW_RULES.md` (project rules) — bot base prompt không sửa được
- User luôn có thể manually override approve trong GitLab UI

---

## Per-project config tham khảo

Xem thêm:
- [`docs/SKILLS.md`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/SKILLS.md) — **workflow skills cho AI agents** (setup webhook, skip reasons, re-trigger, debug)
- [`docs/CONFIG.md`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/CONFIG.md) — full schema `.pi/config.yaml`
- [`agents/REVIEW_RULES.template.md`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/agents/REVIEW_RULES.template.md) — project rules template

---

## FAQ

**Q: Bot có review MR từ fork không?**
A: Có, nếu bot PAT có quyền đọc project target. Webhook config `merge_request_events` bao gồm fork MRs.

**Q: Project private có dùng được không?**
A: Có. Bot PAT cần `api` scope + là member của project. Bot clone qua HTTPS với token.

**Q: Tốn bao nhiêu token Z.ai / MR?**
A: ~10-50k tokens tùy MR size. Lite Plan $12.6/mo đủ ~500-1000 MR/tháng.

**Q: Bot có chạy được với GitLab self-managed không?**
A: Có. Set `GITLAB_URL=https://gitlab.company.com` trong bot env. Webhook URL phải truy cập được từ self-managed instance.

**Q: Có thể dùng LLM khác (DeepSeek, OpenAI) cho project này không?**
A: Có. Set `llm.model: deepseek/deepseek-chat` trong `.pi/config.yaml`. Bot service phải có env `DEEPSEEK_API_KEY` set.

**Q: Bot có thể fix code thay vì chỉ comment không?**
A: Hiện không (MVP). Post-MVP feature: bot auto-push fix commit. Track trong roadmap.

**Q: Có cách nào disable bot tạm thời không?**
A: Có 3 cách:
- GitLab project → Webhook → disable
- MR title chứa "wip" hoặc "dnr" → bot skip
- Branch name `wip/*` hoặc `scratch/*` → bot skip
