# Project Config — `.pi/config.yaml`

Mỗi project có thể tuỳ biến bot behaviour bằng cách tạo file `.pi/config.yaml` trong repo. **File này optional** — nếu thiếu, bot dùng default.

## Vị trí

```
your-project/
├── .pi/
│   ├── config.yaml              ← file này
│   ├── agents/
│   │   └── code-reviewer.md     ← agent instructions (review rules per-project)
│   └── ...
├── AGENTS.md                    ← project context (Pi auto-load)
└── ...
```

Bot clone source branch của MR (`--depth 1`) → đọc `.pi/config.yaml` từ đó. **Commit config trên branch bạn đang review**, không cần merge trước.

---

## Schema đầy đủ

```yaml
# .pi/config.yaml

review:
  # Ngôn ngữ comment: "vi" | "en". Default: "vi"
  language: vi

  # Regex (JS syntax, KHÔNG dùng (?i) — bot tự case-insensitive)
  # Nếu match MR title → skip review
  skipTitleRegex: "\\b(wip|dnr|do not review)\\b"

  # Nếu match source branch → skip review
  skipBranchRegex: "^(wip|scratch)/.*"

scope:
  # Bật Scope Alignment Check (bot verify MR có giải quyết task không)
  enabled: false

  # Convention branch → extract task ID. Vd "feat/T-11-stream" → task T-11
  convention: "feat/T-XX-*"

  # Pattern search trong MR description để tìm issue link
  # Capture group 1 = issue number
  resolvesPattern: "Resolves: #(\\d+)"

  # File trong repo để tra cứu task definition (path relative)
  # Bot hint agent đọc file này khi review
  taskIndex: docs/design/07-roadmap.md

llm:
  # Override model. Default: env DEFAULT_MODEL của bot (zai-anthropic/glm-5.2)
  # Format: provider/model-id
  model: zai-anthropic/glm-5.2

block:
  # Bật merge gate — bot approve/unapprove dựa trên verdict.
  # PHẢI kết hợp với Approval Rule trong GitLab project settings
  # (xem docs/SETUP.md "Enable merge gate") để thực sự block merge.
  #
  # Mapping verdict → approval state:
  #   APPROVE          → bot approve   → MR unblocked
  #   REQUEST_CHANGES  → bot unapprove → MR blocked
  #   COMMENT / UNKNOWN → bot unapprove → MR blocked (conservative)
  enabled: false

ci:
  # Bật CI wait mode — bot chỉ review khi CI pipeline pass.
  # Mặc định: false (review ngay khi MR webhook đến).
  # Khi bật, project phải enable thêm "Pipeline events" webhook trên GitLab
  # (xem section "CI Integration" bên dưới).
  require: false

  # Timeout đợi CI (ms). Default: lấy từ env CI_WAIT_TIMEOUT_MS của bot (600000 = 10 phút).
  # Project CI chậm (E2E, monorepo) → tăng. Project CI nhanh → giảm.
  # Bỏ trống → dùng default của bot service.
  # waitTimeoutMs: 600000
```

---

## Default (khi thiếu file)

```yaml
review:
  language: vi
  skipTitleRegex: "\\b(wip|dnr|do not review)\\b"
  skipBranchRegex: "^(wip|scratch)/.*"
scope:
  enabled: false
llm: {}
block:
  enabled: false
ci:
  require: false
```

---

## Ví dụ per-project

### Project dùng ADR + task convention (vd LTStream)

```yaml
review:
  language: vi

scope:
  enabled: true
  convention: "feat/T-XX-*"
  resolvesPattern: "Resolves: #(\\d+)"
  taskIndex: docs/design/07-roadmap.md
```

### Project solo dev, review tiếng Anh

```yaml
review:
  language: en
```

### Project multi-repo monorepo

```yaml
review:
  language: en
  skipBranchRegex: "^(wip|scratch|dependabot)/.*"

scope:
  enabled: false   # monorepo không có task convention
```

### Project muốn dùng DeepSeek thay Z.ai

```yaml
llm:
  model: deepseek/deepseek-chat
```

> ⚠️ Bot phải có env var `DEEPSEEK_API_KEY` set (qua `fly secrets set`) để dùng provider này.

### Project muốn block merge cho đến khi bot approve

```yaml
block:
  enabled: true

scope:
  enabled: true
  convention: "feat/T-XX-*"
  resolvesPattern: "Resolves: #(\\d+)"
  taskIndex: docs/design/07-roadmap.md
```

Sau đó **phải setup Approval Rule trong GitLab project** (xem [`docs/SETUP.md`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/SETUP.md#3-enable-merge-gate-t%C3%B9y-ch%E1%BB%8Dn)) để bot approval là required — nếu không `block.enabled` chỉ approve/unapprove mà không thực sự chặn merge.

Workflow:
1. MR mở → bot unapprove (chưa review) → MR **blocked**
2. Bot review xong → verdict APPROVE → bot approve → MR **unblocked**
3. Author push commit mới → GitLab reset approval → bot re-review → approve/unapprove

Override: user có thể manually approve trong GitLab UI để merge khẩn cấp (bot không chặn vật lý).

### Project muốn review chỉ khi CI pass

```yaml
ci:
  require: true
  # waitTimeoutMs: 900000   # 15 phút (project có E2E chậm)
```

Sau đó **phải enable "Pipeline events" webhook trên GitLab** (xem section "CI Integration" bên dưới). Workflow:

1. MR webhook đến + CI đang chạy → bot post "⏸ Đợi CI pass" + đợi
2. CI `status=success` → bot trigger review tự động
3. CI fail/canceled → bot skip + post note "🚫 CI failed"
4. CI chạy >timeout (default 10 phút) → bot proceed review anyway

---

## CI Integration

Bot có thể **đợi CI pipeline pass** trước khi review — tránh lãng phí token AI review code mà CI sẽ catch lỗi anyways (lint, typecheck, test fail).

### Khi nào nên bật?

| Case | Nên bật? | Lý do |
|---|---|---|
| Project có `.gitlab-ci.yml` chạy lint+test | ✅ Có | Tiết kiệm token, AI tập trung review logic |
| Project monorepo CI chậm (E2E 10+ phút) | ✅ Có | Set `waitTimeoutMs` cao |
| Project chưa setup CI | ❌ Không | Bot review ngay (lenient default) |
| Project docs-only (chỉ markdown) | ❌ Không | CI không có ý nghĩa |

### Schema

```yaml
ci:
  # Bật CI wait mode. Default: false.
  require: true

  # Timeout đợi CI (ms). Optional — bỏ trống = dùng env default.
  # Per-project override cho CI chậm/nhanh.
  waitTimeoutMs: 900000   # 15 phút
```

### Timeout resolution (priority từ cao → thấp)

| # | Source | Default | Khi nào dùng |
|---|---|---|---|
| 1 | `.pi/config.yaml` → `ci.waitTimeoutMs` | (unset) | Per-project tinh chỉnh |
| 2 | Env `CI_WAIT_TIMEOUT_MS` của bot | `600000` (10 phút) | Server-wide default |
| 3 | Hardcoded fallback | `600000` (10 phút) | Khi env cũng không set |

Ví dụ: monorepo có E2E chậm → set `waitTimeoutMs: 1_800_000` (30 phút) trong `.pi/config.yaml`. Project nhanh → để trống, dùng default 10 phút.

### Setup — yêu cầu GitLab webhook

Project **PHẢI** enable thêm webhook trigger:

```
Project → Settings → Webhook
  Trigger: ✅ Merge request events (đã có)
           ✅ Pipeline events (THÊM — cho CI wait mode)
  Secret token: <cùng WEBHOOK_SECRET>
```

> ⚠️ Nếu chỉ enable `ci.require: true` mà quên enable "Pipeline events" webhook, bot sẽ enqueue pending review nhưng không bao giờ nhận được signal CI finish → review sẽ chạy sau timeout (default 10 phút).

### Workflow

```
1. Dev mở MR (branch feat/T-XX-*)
   ↓
2. GitLab gửi MR webhook tới bot
   ↓
3. Bot clone source branch, load .pi/config.yaml
   ↓
4. Bot check pipeline status qua GitLab API:
   ├── CI running → enqueue pending + post "⏸ Đợi CI pass"
   │   ↓ (sau vài phút)
   │   GitLab gửi pipeline webhook status=success
   │   ↓
   │   Bot trigger review (skipCiCheck=true)
   ├── CI failed/canceled → post "🚫 CI failed" + (block? unapprove) + DONE
   ├── CI success → review luôn
   └── no pipeline (repo chưa setup CI) → review luôn (lenient default)
   ↓
5. Pi Coding Agent review + post comments + approve/request_changes
```

### Re-push behavior (khi đang review hoặc đang đợi CI)

Bot xử lý push mới theo cơ chế **cancel-and-restart** — review cũ (đang chạy hoặc đang chờ CI) bị huỷ, review mới cho commit mới bắt đầu fresh.

**Khi review đang chạy + push mới:**

```
T0: push SHA=a → review SHA=a bắt đầu (đang gọi AI)
T1: push SHA=b → bot CANCEL review SHA=a qua AbortSignal:
    - Pi SDK session.abort() → AI dừng ngay
    - Bot không post note/approve cho SHA=a (im lý)
    - Bot chạy review SHA=b fresh
→ Tránh: duplicate comment, race condition giữa 2 review, sai SHA diff
```

**Khi đang đợi CI + push mới:**

```
T0: push SHA=a → CI chạy → bot post note "⏸ Đợi CI" + enqueue pending
T1: push SHA=b → bot clear pending entry SHA=a (sẽ không trigger khi P_a xong)
    + post note "⏸ Đợi CI" cho SHA=b (lần này, không duplicate cho SHA=a)
```

**2 MR khác nhau** chạy song song bình thường (không cancel lẫn nhau — key là `projectId:mrIid`).

### Edge cases

| Case | Behavior |
|---|---|
| Repo chưa setup `.gitlab-ci.yml` | Bot review luôn (lenient — không block team chưa có CI) |
| CI chạy >timeout | Bot proceed review anyway + log warning |
| Bot restart khi đang đợi CI | Pending lost → user push commit để retry (giống bot error pattern) |
| Re-push commit khi đang pending | Entry cũ bị clear theo MR IID → pipeline webhook cho SHA cũ không trigger review nhầm |
| Pipeline webhook đến không có pending | Skip idempotent (MR đã review, đã re-push, hoặc `ci.require=false`) |
| Pipeline `skipped` (vd manual job skip) | Coi như fail → bot skip review + note |
| CI fail khi `block.enabled=true` | Bot unapprove (giữ merge blocked) |
| Nhiều pipeline song song cho 1 push (branch + MR pipeline) | Bot aggregate TẤT CẢ pipeline cùng SHA — require tất cả pass mới review |
| Pipeline webhook đến cho SHA cũ (sau re-push) | Bot ignore — entry đã bị clear khi re-push |
| Parent-child pipeline (downstream, `trigger:` keyword) | Bot chỉ check parent pipeline — child pipeline không tracked. **Known limitation** (xem bên dưới) |

### Multi-pipeline handling

GitLab có thể chạy **nhiều pipeline song song** cho cùng 1 push:

| Pipeline | Source | Khi nào |
|---|---|---|
| Branch pipeline | `push` | Push commit lên branch |
| MR pipeline | `merge_request_event` | Mở/cập nhật MR (workflow chuẩn GitLab) |

Bot **aggregate TẤT CẢ pipeline có cùng SHA** với commit đang review:

- Bất kỳ pipeline nào running/pending → bot **đợi** (xem như CI đang chạy)
- Tất cả success → bot proceed review
- Có pipeline fail + không còn running → bot skip review + note

Ví dụ: branch pipeline fail + MR pipeline success → bot coi như **CI fail** (conservative). Ngược lại workflow GitLab chuẩn (chỉ MR pipeline) → bot check như bình thường.

### Known limitations

❌ **Pending CI wait lưu in-memory** — không persist khi bot restart. Nếu bot restart giữa lúc đang đợi CI, user cần push commit mới để trigger lại. Post-MVP: persist sang Redis/disk.

❌ **Parent-child pipelines (downstream)**: project dùng `trigger:` keyword để spawn child pipeline (vd monorepo per-package). Bot chỉ check parent pipeline status — child pipeline không tracked. Tức là parent có thể `success` ngay khi trigger xong trong khi child vẫn chạy → bot review sớm. Workaround: cấu hình CI parent pipeline đợi child pipeline xong (vd `needs:`) trước khi parent reported success.

### Troubleshooting

**"Bot đợi hoài không review"** — kiểm tra:
1. GitLab project → Settings → Webhook → có tick ✅ "Pipeline events" không?
2. Test pipeline webhook: GitLab → Webhook → Test → Pipeline events → bot log có `[webhook] pipeline success` không?
3. SHA trong pipeline webhook có khớp với `source_branch_sha` của MR không? (Bot match theo SHA, không phải MR IID)

**"CI pass nhưng bot không review"** — có thể:
1. `ci.require: false` (default) → bot đã review ngay từ đầu, pending không được enqueue
2. Pipeline webhook đến trước MR webhook (rare) → bot chưa kịp enqueue → skip
3. Bot restart giữa chừng → pending lost → push commit để retry

### Known limitation

❌ Pending CI wait lưu **in-memory** — không persist khi bot restart. Nếu bot restart giữa lúc đang đợi CI, user cần push commit mới để trigger lại. Post-MVP: persist sang Redis/disk.

---

## Agent markdown (`.pi/agents/code-reviewer.md`)

Ngoài config.yaml, project có thể override **toàn bộ review rules** bằng cách tạo agent markdown. Xem template tại [LTStream `.pi/agents/code-reviewer.md`](https://gitlab.com/lttech-ga/live-stream/-/blob/main/.pi/agents/code-reviewer.md) cho ví dụ đầy đủ (DDD/Hexagonal rules, LGPL license check, scope alignment checklist).

Bot tự nhận agent này nếu file tồn tại. Không cần config thêm.

---

## Regex syntax

Bot dùng **JavaScript RegExp** — không phải PCRE. Lưu ý:

| Cú cũ (PCRE) | JS-compatible |
|---|---|
| `(?i)pattern` | (bot tự case-insensitive, KHÔNG dùng `(?i)`) |
| `\bword\b` | `\bword\b` (OK) |
| `(?P<name>...)` | `(?<name>...)` |
| `(?=...)` lookahead | OK |
| `(?:...)` non-capture | OK |

Test regex trước: <https://regex101.com> (chọn Flavor = ECMAScript).

---

## Validation

Bot parse config.yaml với `yaml` package + merge với default. Nếu parse fail:

```
[review !42] warn — config.yaml parse failed: <error>; using defaults
```

Review vẫn chạy với default config — không fail toàn bộ.

---

## Best practices

1. **Commit `.pi/` vào main** — bot clone source branch nên cần có sẵn
2. **Không set secret trong config.yaml** — bot tự lấy từ env
3. **Test sau khi đổi config** — mở MR nhỏ để verify bot nhận rules mới
4. **Version config** — comment ngày update ở đầu file để trace
