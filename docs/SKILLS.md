# SKILLS.md — Luồng công việc với Pi Reviewer Bot

> 🔧 **D17 — CI-job mode**: bot chạy như **GitLab CI job** (`pi-review`) cuối pipeline.
> Push MR → pipeline → CI pass (`needs:`) → `pi-review` job → bot approve/request_changes.
> KHÔNG còn webhook server, KHÔNG còn "Đợi CI pass" / "CI failed" note (ciwait/ci.require
> đã purge). Setup: [USAGE.md](USAGE.md) + [CI_SETUP.md](CI_SETUP.md).

> Tài liệu này dành cho **developer và AI agent** (Claude Code, Cursor, Pi, Codex...)
> làm việc trong GitLab project **đã tích hợp pi-reviewer-bot**. Đây là các luồng công
> việc bạn gặp **mỗi khi tạo hoặc cập nhật Merge Request**.
>
> Mỗi skill mô tả: khi nào gặp, bot sẽ làm gì, bạn cần làm gì tiếp.

---

## Skill 1 — Mở MR để trigger review

**Khi nào**: bạn vừa mở MR mới hoặc push commit lên MR đang mở.

### Trigger flow (CI-job mode)

```
Push commit → GitLab trigger pipeline (merge_request_event)
   │
   ▼  jobs trong `needs:` chạy (lint, test, build, ...)
   │  all pass
   ▼
pi-review job (stage: review, ephemeral runner)
   ├─ Đọc context từ GitLab CI predefined env (CI_MERGE_REQUEST_*, CI_PROJECT_*)
   ├─ Load .pi/config.yaml
   ├─ unapprove MR nếu block.enabled (revoke approval cũ)
   ├─ fetch diff qua GitLab API
   ├─ AI reviewer chạy 13 tools (fetch_file + fetch_urls hỗ trợ batch) → post inline comments + summary verdict
   └─ exit code → MR state (exit 1 = MR blocked)
```

### MR conditions để `pi-review` job chạy + bot xử lý

| # | Điều kiện | Đúng | Sai (skip/blocked) |
|---|---|---|---|
| 1 | Job chạy trong MR context | `rules: merge_request_event` match | Push main/tag → job skip (đúng) |
| 2 | `needs:` đã pass | lint/test/build xanh | Job pending hoặc skip do dep fail |
| 3 | Title không match `skipTitleRegex` | `feat: add login` | `WIP: login` / `(do not review)` → bot skip |
| 4 | Branch không match `skipBranchRegex` | `feat/T-11-login` | `wip/login` / `scratch/test` → bot skip |

### Việc của bạn

1. Tạo branch đúng convention (nếu project có `scope.enabled`, vd `feat/T-XX-*`).
2. Commit + push.
3. Mở MR — title rõ ràng, description có `Resolves: #N` nếu project dùng scope alignment.
4. Pipeline tự chạy. CI pass → `pi-review` job review (~30s-5 phút tùy diff + LLM).

---

## Skill 2 — Đợi review (sau khi push commit)

**Khi nào**: bạn vừa push, pipeline đang chạy, đang chờ bot phản hồi.

### Timeline kỳ vọng

```
T+0       Push commit
T+0..?s   Pipeline start: lint/test/build/... chạy (tùy project)
          (pi-review ở stage "review", đợi `needs:` pass)
T+CI-pass  pi-review job start:
            - load config + fetch diff (~1-3s)
            - unapprove MR nếu block.enabled
            - AI review (~30s-5phút tùy diff + LLM provider)
T+CI-pass+review  post comments + summary → exit code → MR state
```

Nếu sau **CI pass + 5 phút** `pi-review` job vẫn running → check job log (Skill 6).

### Trạng thái bot post / job state

| Tín hiệu | Ý nghĩa | Skill |
|---|---|---|
| `pi-review` job **passed** + ✅ summary "Approved" + inline comments | Review OK, bot approve | Skill 3 |
| `pi-review` job **passed** + ⚠️ summary "Changes Requested" + 🔴 inline | Có critical | Skill 3 |
| `pi-review` job **failed** (exit 1) + `## ⚠️ Review inconclusive` | AI chạy xong nhưng không verdict | Skill 5 |
| `pi-review` job **failed** (exit 1) + `## 🤖 Review failed` | Bot error (LLM/network/timeout) | Skill 5 |
| `pi-review` job **skipped** (no note) | Not MR / needs chưa pass / WIP / branch skip | Skill 6 |
| `pi-review` job **pending/running** | Bot đang review | Đợi |

> 💡 **Pipeline status = success ⇔ `pi-review` đã exit 0 ⇔ bot đã post verdict** (Approved /
> Changes Requested, hoặc skip no-comment nếu WIP/no diff). KHÔNG có trạng thái "pipeline xanh
> nhưng chưa có review" — review là 1 job trong pipeline, pipeline pass nghĩa là nó đã chạy xong.

> ⚠️ **KHÔNG còn note "⏸ Đợi CI pass" hay "🚫 CI failed"** — đó là webhook-era (D10).
> CI native `needs:` lo việc đợi CI; nếu CI fail thì `pi-review` job không chạy (pending/skip).

---

## Skill 3 — Đọc summary verdict + inline comments

**Khi nào**: `pi-review` job đã chạy xong, có comment trong MR.

### Bước 1: Đọc summary verdict (top-level note)

Bot luôn post 1 top-level note trước khi approve (guardrail `post_summary`):

```markdown
## ✅ Approved  (hoặc ⚠️ Changes Requested)

**Tóm tắt:** <overall assessment>

**Counts:** 🔴 X critical · 💡 Y suggestion · 🎨 Z nit · ✅ W praise
```

### Bước 2: Xử lý theo verdict

| Verdict | Ý nghĩa | Gate effect | Việc của bạn |
|---|---|---|---|
| **APPROVE** | Code OK, bot approve (`approve_mr`) | Gate 2 unblock (Premium+) | Merge được |
| **REQUEST_CHANGES** | Có ≥1 critical, bot `request_changes` | Gate 2 vẫn block | Fix hết 🔴 → push → re-review |

> **Gate 1 (status check, mọi tier)**: cả APPROVE lẫn changes_requested đều `exit 0` (pipeline pass). Gate 1 KHÔNG phân biệt — chỉ block khi `exit 1` (inconclusive/error). Xem Skill 7.

### Bước 3: Đọc inline DiffNote theo thứ tự ưu tiên

Bot post line-specific DiffNote với 4 severity:

| Severity | Ý nghĩa | Phải fix? |
|---|---|---|
| 🚫 **critical** | Security, crash, data loss, license violation | ✅ **BẮT BUỘC** trước merge (block `approve_mr`) |
| 💡 **suggestion** | Better pattern, performance, readability | Nên fix, không bắt buộc |
| 🎨 **nit** | Style, naming, formatting | Tùy |
| ✅ **praise** | Highlight good pattern | (informational) |

### Việc của bạn

1. Mở MR → tab "Changes".
2. Tìm tất cả 🚫 critical — fix hết trước khi push.
3. suggestion/nit: quyết định fix hay skip (reply "acknowledged" nếu skip — Skill 8).
4. Với mỗi critical đã fix → "Resolve thread" trong GitLab UI.

---

## Skill 4 — Re-push commit (khi đang review hoặc đã xong)

**Khi nào**: cần push commit mới trong lúc bot đang làm việc.

### Cơ chế: pipeline mới = review job mới

CI-job mode: mỗi push = pipeline mới = `pi-review` job ephemeral mới. Bot KHÔNG có
logic "cancel review cũ" (D11 AbortController đã OBSOLETE).

| Trạng thái pipeline cũ | Khi push mới |
|---|---|
| `pi-review` cũ đang chạy | GitLab auto-cancel redundant pipeline (nếu setting `auto_cancel_pending_pipelines` ON) hoặc chạy song song rồi exit |
| Pipeline cũ chưa tới review stage | Pipeline mới start, pipeline cũ bị thay thế |
| Pipeline cũ đã exit | Pipeline mới start fresh |

### Tác động

- **Auto-cancel ON** (default nhiều project): pipeline cũ bị cancel → review job cũ killed mid-review → KHÔNG post comment (AI dừng). Đây là **GitLab behavior**, không phải bot.
- **Auto-cancel OFF**: review job cũ + mới chạy song song → có thể 2 set comment (SHA cũ + SHA mới). Hiếm.
- **Approval revoke**: bot `unapprove` ở đầu mỗi review job (`block.enabled`) → approval cũ revoke khi pipeline mới tới review stage.

### Việc của bạn

- Push bình thường — CI native lo concurrency, KHÔNG cần lo duplicate comment.
- Nếu review job cũ đang chạy và bạn muốn chấm dứt ngay: push commit mới → GitLab auto-cancel.
- Muốn tránh 2 review song song: bật `auto_cancel_pending_pipelines` (Project → Settings → CI/CD → General pipelines).
- 2 MR khác IID (khác branch) → 2 pipeline độc lập, KHÔNG thay thế lẫn nhau.

---

## Skill 5 — Đọc note "🤖 Review failed" / "⚠️ Inconclusive" → fix + re-run

**Khi nào**: `pi-review` job fail (`exit 1`), MR blocked.

### Cơ chế phòng thủ verdict (D19)

Bot có 2 lớp tự phục hồi trước khi báo inconclusive:

1. **Session retry** (`MAX_SESSION_RETRIES=2`): session crash (stream error, JSON parse,
   network) → tạo fresh session, review lại từ đầu. Tối đa 3 attempts.
2. **Verdict remind** (`MAX_VERDICT_REMINDS=2`): cùng session, AI end turn chưa verdict →
   bot nhắc trong context (include state: summary/critical count → AI biết bước tiếp).
   Tối đa 3 turns/session. Rẻ (~5s) vs retry (~3min).

→ Chỉ khi cả 2 lớp thất bại bot mới post note inconclusive. Xem log job để trace.

### Bot post note dạng

```markdown
## 🤖 Review failed

⚠️ **Bot error:** <error message>

_Merge blocked until bot succeeds. Retry pi-review job, manually approve to override._
```

Hoặc inconclusive (note mới D19 — include attempts + gợi ý đọc comment quyết định):

```markdown
## ⚠️ Review inconclusive

Bot finished review (after 3 session retries + 2 verdict reminds) but did not issue a verdict.

**Summary:** <text bot đã post, có thể rỗng>

**Inline comments posted:** X (Y critical). Đọc comments trong tab Changes để quyết định
thủ công: merge nếu OK, hoặc fix + push lại nếu có critical chưa xử lý.

_Inconclusive review blocks merge. Retry pi-review job, manually approve to override, hoặc push commit mới._
```

> 💡 **Bot KHÔNG auto-derive verdict từ inline comments** — user tự đọc comments trong tab
> Changes quyết định. Nếu thấy OK → manually approve + merge; nếu có critical chưa xử lý →
> fix + push commit mới.

`exit 1` → pipeline fail → MR blocked (Gate 1 "Pipelines must succeed").

### Việc của bạn

1. **Check job log**: GitLab MR → tab "Pipelines" → click pipeline → click `pi-review` job → đọc log.
2. **Lỗi phổ biến**:

   | Log / error | Nguyên nhân | Fix |
   |---|---|---|
   | `GITLAB_API_TOKEN === CI_JOB_TOKEN` | Dùng nhầm CI_JOB_TOKEN | Đổi sang PAT/Project Access Token scope `api` ([CI_SETUP §1](CI_SETUP.md)) |
   | `GITLAB_API_TOKEN not set` | Token đánh dấu Protect (chỉ protected branch) | Bỏ `Protect variable`, giữ `Masked` ([CI_SETUP §3](CI_SETUP.md)) |
   | `Missing CI env var: CI_MERGE_REQUEST_IID` | Job chạy ngoài MR context | Template phải có `rules: if: $CI_PIPELINE_SOURCE == "merge_request_event"` |
   | LLM timeout / 401 | Sai API key hoặc provider outage | Check CI/CD Variable key; đổi provider qua `llm.model` |
   | `Review inconclusive` lặp lại | AI burn budget vào tools, không verdict (xem log: nhiều tool calls, no verdict). Bot đã retry session + remind (D19) mà vẫn fail | Tăng `review.limits.maxToolCalls`/`timeoutMs`, đổi `llm.model` mạnh hơn. Nếu gấp → manually approve + merge |

3. **Retry chính `pi-review` job** (không re-run cả pipeline):

   ```
   GitLab MR → Pipelines → click pi-review job → ↻ Retry
   ```

   Chạy lại đúng job đó, cùng SHA, **KHÔNG tốn CI chạy lại lint/test/build**. Đọc log job mới.
   - Nếu fix code rồi mới retry → push commit mới → pipeline mới.
   - Retry 2-3 lần vẫn cùng lỗi → đọc log kỹ lại (bước 2), hoặc báo admin check CI runner/image.

---

## Skill 6 — Debug "Bot im lặng" (không comment, không review)

**Khi nào**: đã push commit, pipeline chạy xong nhưng không có comment/note nào từ bot.

> ⚠️ **KHÔNG còn "check webhook delivery"** — bot là CI job, không nhận webhook.
> Debug bắt đầu từ **pipeline + job state trong GitLab UI**.

### Bước 1: Check pipeline đã chạy + `pi-review` job state

```
GitLab MR → tab "Pipelines"
```

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| Không có pipeline nào | `.gitlab-ci.yml` chưa include template / commit không push | Check `include:` template, push commit |
| Có pipeline nhưng không có `pi-review` job | Template include sai / `stage: review` không có trong `stages:` | Fix `.gitlab-ci.yml` ([USAGE §3.5](USAGE.md)) |
| `pi-review` job **pending** | `needs:` chưa pass | Đợi CI, hoặc fix job phụ thuộc fail |
| `pi-review` job **skipped** | `needs:` có dep fail (skip) hoặc `rules:` không match | Fix dep, check `rules` |
| `pi-review` job **running** | Bot đang review | Đợi (Skill 2) |
| `pi-review` job **failed** | Bot error | Click job → đọc log (Skill 5) |
| `pi-review` job **passed** nhưng không comment | Bot skip (title regex) / no diff | Check title, check `skipTitleRegex` |

### Bước 2: Check job log (nếu job ran)

```
GitLab MR → Pipelines → click pipeline → click pi-review job
```

Log pattern bot skip:

| Log pattern | Ý nghĩa | Fix |
|---|---|---|
| `[review !XX] skip — title/branch matches skipTitle/skipBranch regex` | Title/branch match skip config | Đổi title/branch, hoặc bỏ `skipTitleRegex`/`skipBranchRegex` khỏi `.pi/config.yaml` |
| `[review !XX] skip` + note "No file changes detected" | Diff rỗng | Không phải bug — MR chưa có diff |

### Bước 3: Re-trigger

- **Retry chính `pi-review` job** (GitLab ↻ Retry — chạy lại đúng job, cùng SHA, không tốn CI chạy lại lint/test/build).
- Hoặc **push commit mới** → pipeline mới.

Nếu vẫn không review sau bước 3 → báo admin check CI runner, CI/CD Variables, image bot.

---

## Skill 7 — Merge MR (khi bật merge gate)

**Khi nào**: project bật merge gate, MR đã pass review.

### 2 cơ chế gate

**Gate 1 — protected branch "Pipelines must succeed"** (mọi tier, KHUYẾN NGHỊ):

```
Project → Settings → Repository → Protected branches
  Allowed to merge: Maintainers
  ☑ Pipelines must succeed
```

| `pi-review` exit | Pipeline | Merge |
|---|---|---|
| 0 (approved / changes_requested / skipped) | pass | ✅ mergeable |
| 1 (inconclusive / error) | fail | 🚫 blocked |

> Gate 1 KHÔNG phân biệt approved vs changes_requested (cùng `exit 0`). Nếu bot post 🔴 critical nhưng verdict changes_requested → pipeline vẫn pass → user **tự giác không merge**. Cần block cứng → dùng Gate 2.

**Gate 2 — Approval Rule require bot + `block.enabled: true`** (Premium+ / Self-Managed, tùy chọn thêm):

```
Project → Settings → Merge requests → Approval rules
  Add: "Require bot review", Approvals required: 1, Approvers: <bot user>
```

```
Bot unapprove đầu review (block.enabled) → MR blocked
Bot approve_mr (guardrail: 0 critical + đã post_summary) → MR unblocked
Bot request_changes → KHÔNG approve → vẫn blocked
```

Gate 2 block cứng changes_requested (bot không approve → approval 0/1).

### Workflow trạng thái MR

```
MR mở → pi-review chưa chạy      → (gate1: pipeline chạy / gate2: 0 approval) → BLOCKED 🚫
pi-review chạy xong:
  → approved            → exit 0 → (gate1: pass / gate2: bot approve)   → MERGEABLE ✅
  → changes_requested   → exit 0 → (gate1: pass 🔴 / gate2: blocked)    → fix 🔴 → re-push
  → inconclusive/error  → exit 1 → (gate1: fail / gate2: blocked)       → retry pi-review job
Push commit mới → pipeline mới → bot unapprove → re-review → re-approve/unapprove
```

### Việc của bạn

1. Đợi `pi-review` job pass + (Gate 2) bot approve.
2. Fix hết 🔴 critical → push → pipeline mới → re-review.
3. Job pass → Merge button clickable.

### Override khẩn cấp (merge ngay cả khi bot chưa pass)

- **Gate 1 (status check)**: không override trực tiếp khi bot outage. Admin tạm set
  `allow_failure: true` trên `pi-review` trong template, hoặc fix bot. Không có nút "bypass".
- **Gate 2 (Approval Rule)**: manually "Approve" bằng account developer khác → approval 1/1 →
  merge. Bot chỉ là required approver, user luôn override được.

---

## Skill 8 — Reply comment "acknowledged" cho suggestion/nit

**Khi nào**: bot post `suggestion` (💡) hoặc `nit` (🎨), bạn quyết định không fix.

### Việc của bạn

```
GitLab MR → tab "Changes" → tìm comment suggestion/nit
  → Reply: "Acknowledged, will fix in follow-up MR."
  → Resolve thread
```

Bot đọc top-level notes qua `list_mr_comments()` cho idempotent re-review. Resolved thread
= tín hiệu bạn đã xem; bot không re-flag suggestion/nit đã resolve.

### Khi nào KHÔNG nên resolve

- 🚫 **critical** chưa fix → KHÔNG resolve (bot sẽ re-flag trong re-review nếu còn).
- Suggestion bạn chưa quyết định → để mở, reply "considering".

---

## Cheat sheet — trạng thái MR + action tiếp theo

```
Push commit
     ↓
Pipeline chạy (lint/test/build → pi-review cuối)
     ↓
pi-review job status?
     ├── Pending                → đợi needs (Skill 2)
     ├── Skipped (not MR / WIP) → check rules/skipRegex (Skill 6)
     ├── Running                → đợi (Skill 2)
     ├── Failed (exit 1)        → đọc log → retry CHÍNH job đó (Skill 5)
     │                            (bot đã post: ⚠️ Inconclusive hoặc 🤖 Review failed)
     └── Passed (exit 0) → kết quả review ĐÃ trong MR:
          ├── ✅ Approved          → merge (Skill 7)
          ├── ⚠️ Changes Requested → fix 🚫 critical → push (Skill 4) → re-review
          └── (skip, no comment)   → check title/branch/skipRegex (Skill 6)
```

---

## Tham khảo

- [USAGE.md](USAGE.md) — setup bot cho project của bạn (lần đầu), luồng daily đầy đủ
- [CI_SETUP.md](CI_SETUP.md) — tier-aware token + merge gate + CI/CD Variables
- [CONFIG.md](CONFIG.md) — full schema `.pi/config.yaml`
- [ARCHITECTURE.md](ARCHITECTURE.md) — design decisions, decision log D1-D18
- [agents/code-reviewer.md](../agents/code-reviewer.md) — system prompt AI reviewer (rules bot tuân thủ)
