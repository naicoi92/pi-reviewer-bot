# Integration Guide — Setup pi-reviewer-bot cho project của bạn

> **Audience**: Project owner / AI agent (Claude Code, Cursor, Pi, Codex) đang làm việc trong
> **repo GitLab khác** và muốn enable AI code review cho repo đó.
>
> Doc này hướng dẫn từng bước để tích hợp pi-reviewer-bot vào project —
> **không phải setup bản thân bot service**. Nếu bạn cần deploy bot, xem
> [SETUP.md](SETUP.md) trước, rồi quay lại đây.

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

# 2. Copy agent prompt (tùy chỉnh)
cp /path/to/pi-reviewer-bot/agents/code-reviewer.md .pi/agents/

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
| **Webhook URL truy cập được từ GitLab** | Bot service đã deploy (xem [SETUP.md](SETUP.md)) |
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

## Bước 2 — Copy + tùy chỉnh agent prompt

Bot dùng system prompt từ `.pi/agents/code-reviewer.md` (nếu tồn tại).
Copy template từ pi-reviewer-bot repo, hoặc tạo mới:

```bash
mkdir -p .pi/agents
```

```markdown
<!-- .pi/agents/code-reviewer.md -->
---
description: AI code reviewer cho project này
---

# Code Reviewer Agent — <tên project>

Bạn là AI code reviewer cho **<tên project>** (<mô tả ngắn 1 dòng>).

## Stack & conventions

- **Language**: <vd Rust, TypeScript, Python...>
- **Framework**: <vd Tauri, SolidJS, Django...>
- **Architecture**: <vd DDD, MVC, microservices...>
- **Code style**: <vd strict TS, no any, format with prettier>

## Review focus (theo layer)

### <vd src-tauri/**/*.rs — Rust backend>
- Async correctness, ownership, Result/Option handling
- No unwrap() ở production path

### <vd src/**/*.{ts,tsx} — SolidJS frontend>
- Reactivity patterns, accessibility, i18n

## Project-specific rules

- <vd License LGPL — no GPL crate>
- <vd No new dependencies without ADR>
- <vd Tests required for new features>

## Task convention (nếu scope.enabled = true)

- Branch: `feat/T-XX-*` → task T-XX
- MR description: `Resolves: #N` → issue #N
- Task index: `<path-to-roadmap-file>`
```

**Quan trọng**: agent prompt quyết định **chất lượng review**. Viết càng cụ thể cho
project, bot càng chính xác. Không có file này → bot dùng default (generic, ít hữu ích).

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
| **Trigger** | ✅ **Merge request events** |
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

## Workflow review từ góc nhìn project

```
1. Dev mở MR (branch feat/T-XX-*)
   ↓
2. GitLab gửi webhook tới bot
   ↓
3. Bot clone source branch (depth 1)
   ↓
4. Bot đọc .pi/config.yaml + .pi/agents/code-reviewer.md + AGENTS.md
   ↓
5. Bot spawn Pi Coding Agent với GLM-5.2:
   - AI dùng 10 tools để review
   - fetch_file khi cần context
   - get_issue(iid) nếu Resolves: #N
   - list_mr_comments() nếu re-review
   - post_inline_comment(path, line, comment, severity)
   - post_summary(markdown)
   - approve_mr(rationale) HOẶC request_changes(reason)
   ↓
6. Comment xuất hiện trong MR sau ~30s-3 phút
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

Mỗi package có thể có `.pi/agents/code-reviewer.md` riêng (nếu muốn).

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

### Review chất lượng kém

| Triệu chứng | Fix |
|---|---|
| Bot review generic, không biết conventions | Viết `.pi/agents/code-reviewer.md` cụ thể hơn |
| Bot không biết task convention | Bật `scope.enabled` trong `.pi/config.yaml` |
| Bot comment tiếng Anh dù muốn VN | Set `review.language: vi` |
| Bot không đọc được ADRs | Đảm bảo file trong repo HOẶC dùng `get_wiki_page` tool |

### Bot approve nhầm / request_changes nhầm

- Bot có guardrail: phải `post_summary` trước + 0 critical mới approve
- Nếu verdict sai → review agent prompt trong `.pi/agents/code-reviewer.md`
- User luôn có thể manually override approve trong GitLab UI

---

## Per-project config tham khảo

Xem thêm:
- [`docs/CONFIG.md`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/CONFIG.md) — full schema `.pi/config.yaml`
- [`agents/code-reviewer.md`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/agents/code-reviewer.md) — agent prompt template

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
