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

Sau đó **phải setup Approval Rule trong GitLab project** (xem [`docs/SETUP.md`](SETUP.md#3-enable-merge-gate-t%C3%B9y-ch%E1%BB%8Dn)) để bot approval là required — nếu không `block.enabled` chỉ approve/unapprove mà không thực sự chặn merge.

Workflow:
1. MR mở → bot unapprove (chưa review) → MR **blocked**
2. Bot review xong → verdict APPROVE → bot approve → MR **unblocked**
3. Author push commit mới → GitLab reset approval → bot re-review → approve/unapprove

Override: user có thể manually approve trong GitLab UI để merge khẩn cấp (bot không chặn vật lý).

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
