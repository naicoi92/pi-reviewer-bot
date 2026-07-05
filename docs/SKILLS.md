# SKILLS.md — Luồng công việc với Pi Reviewer Bot

> Tài liệu này dành cho **developer và AI agent** (Claude Code, Cursor, Pi, Codex...)
> làm việc trong GitLab project **đã tích hợp pi-reviewer-bot**. Sau khi bot đã
> setup xong (xem [INTEGRATION.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/INTEGRATION.md)), đây là các luồng công việc
> bạn sẽ gặp **mỗi khi tạo hoặc cập nhật Merge Request**.
>
> Mỗi skill mô tả: khi nào gặp, bot sẽ làm gì, bạn cần làm gì tiếp.

---

## Skill 1 — Tạo MR để bot review ngay lập tức

**Khi nào**: bạn vừa mở MR mới hoặc push commit lên MR đang mở.

### MR của bạn cần đạt 4 điều kiện để bot nhận + review

| # | Điều kiện | Ví dụ đúng | Ví dụ sai (bot skip) |
|---|---|---|---|
| 1 | MR không phải Draft | `feat: add login` | `Draft: feat: add login` |
| 2 | Action là `open` / `update` / `reopen` | Push commit (update) | `close` / `merge` / `approved` |
| 3 | Title không chứa WIP/DNR | `feat: add login` | `WIP: login` / `(do not review)` |
| 4 | Branch không thuộc `wip/*` `scratch/*` | `feat/T-11-login` | `wip/login` / `scratch/test` |

### Nếu dùng CI wait mode (`ci.require: true`)

Push commit → GitLab trigger pipeline → bot **không review ngay** mà đợi CI pass
(xem Skill 3). Bạn sẽ thấy note "⏸ Đợi CI pass" trong MR.

### Việc của bạn

1. Tạo branch đúng convention (nếu project có `scope.enabled`, vd `feat/T-XX-*`).
2. Commit + push lên remote.
3. Mở MR từ GitLab UI (hoặc tool bạn quen) — title rõ ràng, description có
   `Resolves: #N` nếu project dùng scope alignment.

→ Bot nhận webhook trong <2s, bắt đầu review sau ~5-30s (clone repo + load config).

---

## Skill 2 — Đợi bot review (sau khi push commit)

**Khi nào**: bạn vừa push, MR đã mở, đang chờ bot phản hồi.

### Timeline kỳ vọng

```
T+0s     Push commit
T+2s     GitLab gửi webhook tới bot
T+5-30s  Bot clone repo + load .pi/config.yaml + fetch diff
T+30s-5phút  Bot chạy AI review (10 tools) + post comments + approve/request_changes
```

Nếu sau **5 phút** vẫn không có comment gì → xem Skill 9 (debug "bot im lặng").

### Việc của bạn

- **Đợi**. Không push commit mới (nếu push, review cũ sẽ bị huỷ — xem Skill 6).
- Nếu `block.enabled: true`: MR sẽ ở trạng thái **blocked** cho đến khi bot approve.

### Các trạng thái bot có thể post

| Note bot post | Ý nghĩa | Skill xử lý |
|---|---|---|
| (không có note, có inline comment + summary) | Review thành công | Skill 4 |
| `⏸ Đợi CI pass` | CI đang chạy, bot đợi | Skill 3 |
| `🚫 CI failed` | CI fail, bot skip review | Skill 5 |
| `🤖 Review failed (Bot error)` | Bot crash (rare) | Skill 7 |
| `⚠️ Review inconclusive` | AI không verdict được | Skill 8 |

---

## Skill 3 — Đọc note "⏸ Đợi CI pass" → đợi

**Khi nào**: project có `ci.require: true`, bạn push commit, CI bắt đầu chạy.

### Bot sẽ post note dạng

```
## ⏸ Đợi CI pass

Pipeline đang chạy (running). Bot sẽ review tự động khi CI pass.

SHA: abc12345 · Timeout: 600s
```

### Việc của bạn

1. **Mở pipeline status** trong GitLab MR (tab "Pipelines") để xem CI chạy tới đâu.
2. **Đợi** — KHÔNG push commit mới trong lúc này (xem Skill 6 để hiểu lý do).
3. Khi CI pass → GitLab gửi pipeline webhook → bot tự trigger review (sau ~30s-5 phút).
4. Khi CI fail → bot post note `🚫 CI failed` → chuyển Skill 5.

### Edge case: CI chạy quá lâu

Nếu CI chạy lâu hơn timeout (default 10 phút), bot sẽ **proceed review anyway**
sau timeout + log warning. Bạn không cần làm gì — vẫn sẽ nhận được review.

### Edge case: re-push commit trong lúc CI chạy

Bạn push commit mới để fix CI flake:
- Pending entry cũ (SHA=a) bị clear → bot đợi CI của SHA mới (SHA=b).
- Note "⏸ Đợi CI pass" mới sẽ được post cho SHA=b (note cũ SHA=a vẫn còn — đây là lịch sử).

---

## Skill 4 — Đọc inline comments + summary verdict

**Khi nào**: bot đã review xong, có comment trong MR.

### Bước 1: Đọc summary verdict (top-level comment)

Bot luôn post 1 top-level note dạng:

```markdown
## 🤖 Review (Pi + GLM-5.2)

### Verdict: APPROVE | REQUEST_CHANGES

**Summary:** <overall assessment>

**Counts:** 🔴 X critical · 🟡 Y suggestions · 🔵 Z nits · ✅ W praise
```

### Bước 2: Xử lý theo verdict

| Verdict | Ý nghĩa | Việc của bạn |
|---|---|---|
| **APPROVE** | Code OK, bot đã approve | Merge được (nếu `block.enabled: true` thì MR đã unblocked) |
| **REQUEST_CHANGES** | Có ≥1 critical issue | Đọc critical inline comment → fix → push → re-review (Skill 6) |

### Bước 3: Đọc inline comments theo thứ tự ưu tiên

Bot post DiffNote line-specific với 4 severity:

| Severity | Ý nghĩa | Phải fix? |
|---|---|---|
| 🔴 **critical** | Security, crash, data loss, license violation | ✅ **BẮT BUỘC** trước merge (block approve) |
| 🟡 **suggestion** | Better pattern, performance, readability | Nên fix, không bắt buộc |
| 🔵 **nit** | Style, naming, formatting | Tùy |
| ✅ **praise** | Highlight good pattern | (informational) |

### Việc của bạn

1. Mở MR trong GitLab UI → tab "Changes".
2. Tìm tất cả comment có 🔴 critical — fix hết trước khi push.
3. Suggestion/nit: quyết định fix hay skip (reply "acknowledged" nếu skip).
4. Đối với mỗi critical đã fix → "Resolve thread" trong GitLab UI.

---

## Skill 5 — Đọc note "🚫 CI failed" → fix CI

**Khi nào**: project có `ci.require: true`, CI pipeline fail/canceled/skipped.

### Bot sẽ post note dạng

```
## 🚫 CI failed — skip review

Pipeline failed. Bot sẽ không review cho commit này.

Fix CI và push commit mới để trigger review lại.
```

### Việc của bạn

1. Mở GitLab MR → tab "Pipelines" → xem job nào fail.
2. Fix lỗi CI (lint, typecheck, test, build...).
3. Push commit mới.
4. Bot sẽ re-check pipeline status của commit mới. Nếu pass → review. Nếu fail tiếp → lặp lại.

### Edge case: CI fail vì flake test

Nếu CI fail vì test flaky (không phải do code bạn):
- **Retry pipeline** trong GitLab UI → pipeline mới chạy lại với cùng SHA.
- Pipeline webhook `status=success` đến → bot trigger review (nếu pending entry còn).
- Nếu pending entry đã expire (timeout) → push commit (có thể empty commit) để re-trigger.

---

## Skill 6 — Re-push commit (khi đang review hoặc đang đợi CI)

**Khi nào**: bạn cần push commit mới trong lúc bot đang làm việc.

### Cơ chế: cancel-and-restart

Bot **cancel** review cũ và **start** review mới cho commit mới:

```
T0: push SHA=a → bot đang review SHA=a
T1: push SHA=b → bot AbortSignal review SHA=a:
    - AI dừng ngay
    - Bot KHÔNG post note/comment cho SHA=a (im lặng)
    - Bot chạy review SHA=b fresh
```

### Tác động

| Trạng thái bot | Khi push mới |
|---|---|
| Đang review SHA=a | Review SHA=a bị huỷ → bot review SHA=b |
| Đang đợi CI SHA=a | Pending entry SHA=a bị clear → bot đợi CI SHA=b |
| Đã review xong SHA=a | Push commit mới → bot re-review SHA=b từ đầu |

### Việc của bạn

- **Không cần lo về duplicate comment** — review cũ bị huỷ nên không có comment thừa.
- **Token AI đã dùng cho review cũ bị mất** (trade-off chấp nhận được — tránh spam).
- **Nếu push 5 commit liên tiếp** nhanh: chỉ commit cuối được review, 4 commit đầu bị huỷ. Đây là behavior đúng — không phải bug.
- **2 MR khác nhau** (khác MR IID) không huỷ lẫn nhau — review song song bình thường.

---

## Skill 7 — Đọc note "🤖 Review failed (Bot error)" → re-trigger

**Khi nào**: bot crash (rare) — timeout, GitLab API fail, model unavailable.

### Bot sẽ post note dạng

```
## 🤖 Review failed

⚠️ Bot error: <error message>

Bot will retry on next push.
```

### Việc của bạn

Re-trigger review bằng 1 trong 2 cách:
- **Cách A (recommend)** — push commit (có thể empty commit để chỉ trigger webhook).
- **Cách B** — Close rồi Reopen MR trong GitLab UI.

Bot sẽ re-review. Nếu vẫn fail liên tục → liên hệ admin bot service (check `/healthz`).

---

## Skill 8 — Đọc note "⚠️ Review inconclusive" → re-trigger

**Khi nào**: bot chạy review xong nhưng AI không issue verdict (vd timeout giữa chừng, model yếu).

### Bot sẽ post note dạng

```
## ⚠️ Review inconclusive

Bot finished review but did not issue a verdict.

Summary: <text bot đã post, có thể rỗng>

Inconclusive review blocks merge. Push a new commit to retry, or manually approve to override.
```

### Việc của bạn

1. **Đọc partial summary** (nếu có) — có thể có thông tin hữu ích dù không verdict.
2. **Re-trigger review** — push commit (có thể empty commit) hoặc reopen MR.
3. Nếu vẫn inconclusive sau 2-3 lần thử → có thể model yếu, cần admin bot đổi model (`llm.model` trong `.pi/config.yaml` hoặc `DEFAULT_MODEL` env).

---

## Skill 9 — Debug "Bot im lặng" (không comment, không review)

**Khi nào**: đã push commit >5 phút, không thấy comment/note nào từ bot.

### Bước 1: Check webhook delivery

```
GitLab project → Settings → Webhooks → click webhook → "Recent events"
```

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| Không có event nào | Webhook chưa enable đúng trigger | Check tick "Merge request events" (và "Pipeline events" nếu ci.require) |
| Event có nhưng 4xx/5xx response | Bot service down / URL sai / secret sai | Liên hệ admin bot service |
| Event có, 200 OK | Bot nhận được nhưng skip hoặc đang chạy | Đi bước 2 |

### Bước 2: Check skip reasons (nếu có quyền xem bot log)

Bot log sẽ có 1 trong các skip reason sau:

| Log pattern | Ý nghĩa | Fix |
|---|---|---|
| `[webhook] skip !XX — draft` | MR đang Draft | Unmark Draft trong GitLab UI |
| `[webhook] skip !XX — action=approved` | Webhook trigger không phải push/open | Push commit để trigger `action=update` |
| `[webhook] skip !XX — update-without-commit` | Chỉ edit title/description/labels | Push commit (empty commit OK) |
| `[webhook] skip !XX — title-skip-regex` | Title chứa WIP/DNR | Đổi title |
| `[webhook] skip !XX — branch-skip-regex` | Branch match `wip/*` `scratch/*` | Đổi branch name |
| `[webhook] skip !XX — reason=action=test` | Webhook Test từ GitLab UI (không phải MR thật) | Mở MR thật |
| `[review !XX] ci: pipeline running` | CI đang chạy, bot đợi | Đợi CI pass |
| `[review !XX] ci: pipeline failed` | CI fail | Fix CI (Skill 5) |

### Bước 3: Re-trigger thủ công

Push commit (có thể empty commit để chỉ trigger webhook) hoặc reopen MR.

Nếu vẫn không review sau bước 3 → liên hệ admin bot service.

---

## Skill 10 — Merge MR (khi `block.enabled: true`)

**Khi nào**: project bật merge gate, MR đã được bot approve.

### Workflow trạng thái MR

```
MR mở         → bot chưa review        → 0/1 approval → BLOCKED 🚫
Bot review:
  → APPROVE          → bot approve      → 1/1 approval → UNBLOCKED ✅ → merge được
  → REQUEST_CHANGES  → bot unapprove    → 0/1          → BLOCKED 🚫 → fix critical → re-review
Push commit mới → bot unapprove NGAY → BLOCKED → bot re-review → re-approve/unapprove
                  (đảm bảo MR blocked trong window review lại)
```

### Việc của bạn

1. **Đợi** bot approve (sau khi fix hết critical + push).
2. Khi MR unblocked → **Merge** button clickable trong GitLab UI.
3. Push commit mới bất kỳ → GitLab auto-reset approval → bot re-review → re-approve.

### Override khẩn cấp (merge ngay cả khi bot chưa approve)

```
GitLab MR → Merge requests → Approval rules
  → manually click "Approve" với account developer khác
  → Approvals required: 1/1 → unblocked → merge
```

Bot không chặn vật lý — chỉ là required approver. User luôn có thể override.

---

## Skill 11 — Reply comment "acknowledged" cho suggestion/nit

**Khi nào**: bot post `suggestion` hoặc `nit`, bạn quyết định không fix.

### Việc của bạn

```
GitLab MR → tab "Changes" → tìm comment suggestion/nit
  → Reply: "Acknowledged, will fix in follow-up MR."
  → Resolve thread
```

Bot không re-check resolved thread ở review sau (chỉ đọc top-level notes qua
`list_mr_comments()`). Resolved thread = tín hiệu bạn đã xem.

### Khi nào KHÔNG nên resolve

- 🔴 **critical** chưa fix → KHÔNG resolve (bot sẽ re-flag trong re-review nếu còn).
- Suggestion bạn chưa quyết định → để mở, reply "considering".

---

## Cheat sheet — trạng thái MR + action tiếp theo

```
Bạn push commit
       ↓
Bot có post note trong 30s không?
       ├── KHÔNG (sau 5 phút) → Skill 9 (debug)
       └── CÓ:
            ├── "⏸ Đợi CI pass"     → Skill 3 (đợi)
            ├── "🚫 CI failed"       → Skill 5 (fix CI)
            ├── "🤖 Review failed"   → Skill 7 (retry)
            ├── "⚠️ Inconclusive"    → Skill 8 (retry)
            └── (inline + summary)   → Skill 4 (đọc verdict)
                                         ↓
                                    Verdict:
                                    ├── APPROVE → Skill 10 (merge)
                                    └── REQUEST_CHANGES → fix critical → Skill 6 (re-push)
                                                                                ↓
                                                                          Bot re-review
                                                                                ↓
                                                                          (loop về đầu)
```

---

## Tham khảo

- [INTEGRATION.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/INTEGRATION.md) — setup bot cho project của bạn (lần đầu)
- [CONFIG.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/CONFIG.md) — full schema `.pi/config.yaml`
- [agents/code-reviewer.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/agents/code-reviewer.md) — system prompt AI reviewer (rules bot tuân thủ)
- [ARCHITECTURE.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/ARCHITECTURE.md) — design decisions, decision log D1-D11
