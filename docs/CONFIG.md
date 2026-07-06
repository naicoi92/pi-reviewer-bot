# Project Config — `.pi/config.yaml`

> Per-project config cho pi-reviewer-bot. Optional — bot có default hợp lý.
> File nằm ở `<repo>/.pi/config.yaml` (CI runner checkout source branch vào `cwd`).

## Schema đầy đủ

```yaml
review:
  language: vi                              # ngôn ngữ comment: vi | en
  skipTitleRegex: "\\b(wip|dnr|do not review)\\b"  # skip MR có title match
  skipBranchRegex: "^(wip|scratch)/.*"      # skip branch match
  limits:                                   # review execution limits
    maxToolCalls: 30                        # default 30
    timeoutMs: 300000                       # default 300000 (5 min)

scope:
  enabled: false                            # default false — bật scope alignment check
  convention: "feat/T-XX-*"                 # branch pattern → task ID
  resolvesPattern: "Resolves: #(\\d+)"      # MR description → issue number
  taskIndex: docs/design/07-roadmap.md      # file tra cứu task (AI đọc qua fetch_file)

block:
  enabled: false                            # default false — block merge đến khi bot approve

llm:
  model: zai/glm-5.2                        # per-project model override (sole source)
```

## Defaults

| Field | Default | Ghi chú |
|---|---|---|
| `review.language` | `vi` | `vi` \| `en` |
| `review.skipTitleRegex` | `\b(wip\|WIP\|Wip\|dnr\|DNR\|do not review\|Do Not Review)\b` | JS RegExp, không inline `(?i)` |
| `review.skipBranchRegex` | `^(wip\|scratch)/.*` | |
| `review.limits.maxToolCalls` | `30` | số nguyên dương |
| `review.limits.timeoutMs` | `300000` | số nguyên dương (ms) |
| `scope.enabled` | `false` | |
| `block.enabled` | `false` | cần + GitLab Approval Rule |
| `llm.model` | (unset) | unset → Pi auto-detect provider |

## Sections

### `review` — comment language + skip filter + limits

- **`language`**: ngôn ngữ comment (`vi` / `en`).
- **`skipTitleRegex`**: JS RegExp — MR có title match → bot skip (job pass, không review).
  CI `rules:` chỉ filter branch, KHÔNG filter title → bot re-apply ở đây.
- **`skipBranchRegex`**: JS RegExp — source branch match → skip.
- **`limits.maxToolCalls`**: cap tool calls/review (chống spam + chi phí). Từng
  `MAX_TOOL_CALLS_PER_REVIEW` env (đã purge sang config).
- **`limits.timeoutMs`**: review timeout. Từng `REVIEW_TIMEOUT_MS` env.

### `scope` — scope alignment check (optional)

Khi `enabled: true`, AI reviewer verify MR resolve 1 task:

- `convention`: branch pattern extract task ID (vd `feat/T-42-*` → `T-42`).
- `resolvesPattern`: RegExp extract issue từ MR description.
- `taskIndex`: file roadmap/task list (AI đọc qua `fetch_file` để tra cứu).

### `block` — merge gate

`enabled: true` + GitLab Approval Rule require bot → merge blocked đến khi bot approve.
Bot `unapprove` ngay khi pipeline mới chạy (revoke approval cũ), `approve` khi review pass.

### `llm` — model override

`model`: `"provider/model"` (vd `zai/glm-5.2`, `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`).
Unset → Pi auto-detect (first provider có API key). Từng `DEFAULT_MODEL` env (đã purge).

## Examples

### Minimal (chỉ comment, không block)

```yaml
review:
  language: en
```

### Full (block + scope + custom limits)

```yaml
review:
  language: vi
  limits: { maxToolCalls: 50, timeoutMs: 600000 }
scope:
  enabled: true
  convention: "feat/T-XX-*"
  resolvesPattern: "Resolves: #(\\d+)"
  taskIndex: docs/roadmap.md
block:
  enabled: true
llm:
  model: anthropic/claude-3.5-sonnet
```

### Monorepo (review chậm, cần nhiều tool calls)

```yaml
review:
  limits: { maxToolCalls: 60, timeoutMs: 900000 }   # 15 min
```

## Đã loại bỏ (D1-revised)

| Field cũ | Trạng thái |
|---|---|
| `ci.require` | ❌ removed — CI native lo wait qua `needs:` |
| `ci.waitTimeoutMs` | ❌ removed |

Gặp `ci.*` legacy trong config → bot ignore + warn (không crash). Bỏ khỏi config.

Env knobs đã purge sang config: `DEFAULT_MODEL`→`llm.model`,
`MAX_TOOL_CALLS_PER_REVIEW`→`review.limits.maxToolCalls`,
`REVIEW_TIMEOUT_MS`→`review.limits.timeoutMs`.

## Validation

`mergeConfig` validate:

- `review.limits.*`: số nguyên dương. Reject NaN/âm/float → giữ default.
- Fields không nhận diện → ignore (forward-compatible).
- YAML sai syntax → warn + dùng default.
