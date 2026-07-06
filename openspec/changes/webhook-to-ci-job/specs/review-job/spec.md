# Review-Job Specification

> Domain spec cho chế độ GitLab CI job của pi-reviewer-bot (post D1-revised).
> Đây là domain mới (không có canonical spec `openspec/specs/review-job/spec.md`),
> nên viết full spec. Behavior webhook bị loại bỏ hoàn toàn — không còn trong spec.

## Purpose

Bot chạy như một GitLab CI job đặt cuối pipeline (`needs:` tất cả job test/build).
Pipeline pass → job review chạy → đọc context từ CI predefined env vars → chạy Pi
review → approve/request_changes MR qua GitLab API. Không còn HTTP server, không
webhook, không state in-memory giữa các event.

## Requirements

### Requirement: Context từ CI env vars

Hệ thống MUST đọc context MR từ GitLab CI predefined env vars thông qua
`mrContextFromEnv()`. Required vars: `CI_MERGE_REQUEST_IID`, `CI_PROJECT_ID`,
`CI_PROJECT_PATH`, `CI_PROJECT_URL`, `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA`,
`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, `CI_API_V4_URL`, `GITLAB_TOKEN`.

#### Scenario: Đầy đủ env vars

- GIVEN runner GitLab CI có set tất cả required env vars
- WHEN CLI khởi động
- THEN `mrContextFromEnv()` trả object `{ mrIid, projectId, projectPath, projectUrl, sourceSha, targetBranch, apiBase }` đầy đủ

#### Scenario: Thiếu required env var

- GIVEN một required env var thiếu (vd `CI_MERGE_REQUEST_IID` undefined)
- WHEN CLI khởi động
- THEN CLI log error nêu var thiếu + exit code != 0 (KHÔNG fallback SHA, KHÔNG guess)

#### Scenario: Chạy ngoài MR context

- GIVEN pipeline source không phải `merge_request_event` (vd push main branch)
- WHEN template rule `if: $CI_PIPELINE_SOURCE == "merge_request_event"` match
- THEN review job bị skip bởi CI (không chạy, không lỗi)

### Requirement: Token auth (Project Access Token / user PAT)

Hệ thống MUST dùng `GITLAB_TOKEN` là Project Access Token hoặc user PAT (scope `api`,
role approver) — KHÔNG phải `CI_JOB_TOKEN`. Lý do: bot cần POST approve/unapprove/note,
`CI_JOB_TOKEN` chỉ đọc được MR endpoints. Nếu `GITLAB_TOKEN === CI_JOB_TOKEN`, hệ thống
MUST fail fast (exit 1) với message rõ (fail sớm, đỡ debug mò).

#### Scenario: Dùng CI_JOB_TOKEN nhầm

- GIVEN `GITLAB_TOKEN` set bằng `CI_JOB_TOKEN`
- WHEN CLI khởi động
- THEN log error "GITLAB_TOKEN === CI_JOB_TOKEN — ... Use a Project Access Token or user PAT" + exit 1

#### Scenario: PAT hợp lệ

- GIVEN `GITLAB_TOKEN` là Project Access Token (scope api, khác CI_JOB_TOKEN)
- WHEN CLI khởi động
- THEN guard pass, review chạy bình thường

### Requirement: Review pipeline

Hệ thống MUST chạy review theo thứ tự: load config (`cwd`) → unapprove MR (nếu
`block.enabled=true`) → fetch diff qua GitLab API → `runPiReview` (Pi SDK + 12 tools)
→ derive outcome từ toolState. MUST NOT dùng local git clone (`repoDir = process.cwd()`).
MUST NOT gọi ciwait/inflight/limiter (đã loại bỏ).

#### Scenario: Review thành công

- GIVEN context đầy đủ + diff fetch được + Pi review chạy xong
- WHEN toolState cho biết review complete (có summary + verdict)
- THEN derive outcome (approve / request_changes / inconclusive) + post lên MR

#### Scenario: block.enabled=true revoke approval cũ

- GIVEN `.pi/config.yaml` có `block.enabled: true` + MR có approval cũ từ SHA trước
- WHEN pipeline mới chạy review
- THEN hệ thống unapprove MR ngay trước khi review mới (revoke approval cũ)

### Requirement: Exit-code contract (job-fail = block)

Hệ thống MUST exit 0 khi review hoàn tất dù kết quả là approve hay request_changes
(request_changes vẫn giữ MR blocked nhưng job pass). Hệ thống MUST exit != 0 khi
review fail (timeout, LLM error, network, inconclusive) → MR giữ blocked, user re-run
pipeline. Đây là intended safe-default, KHÔNG phải bug.

#### Scenario: Review ok → exit 0

- GIVEN review hoàn tất với verdict rõ ràng (approve hoặc request_changes)
- WHEN CLI kết thúc
- THEN exit code = 0

#### Scenario: LLM provider outage → exit != 0

- GIVEN Pi review throw do LLM API timeout / error
- WHEN CLI bắt error
- THEN log error + exit code != 0 → MR giữ blocked

#### Scenario: Review inconclusive → exit != 0

- GIVEN Pi review kết thúc nhưng toolState không có verdict rõ (không summary / không approve)
- WHEN CLI derive outcome
- THEN log inconclusive + exit code != 0 → MR giữ blocked

### Requirement: Không còn HTTP server / webhook

Hệ thống MUST NOT expose HTTP server (không `/webhook`, `/healthz`, `/stats`). MUST
NOT consume webhook payload (`MergeRequestWebhook`, `Pipeline`). MUST NOT require
`WEBHOOK_SECRET` hay `PORT`. Nếu phát hiện `WEBHOOK_SECRET` vẫn set ở env, hệ thống
SHOULD log warning (không hard-fail — compat window cho user chưa xóa).

#### Scenario: WEBHOOK_SECRET vẫn set

- GIVEN env có `WEBHOOK_SECRET` (user quên xóa sau migration)
- WHEN CLI khởi động
- THEN log warning "`WEBHOOK_SECRET` still set — webhook mode removed, delete it" + tiếp tục bình thường (không exit)

### Requirement: Diff qua GitLab API

Hệ thống MUST fetch MR diff qua GitLab API (không `cloneForReview`). `repoDir` =
`process.cwd()`. `readFileOrNull` giữ nguyên (cho `fetch_file` tool). `ClonedRepo.cleanup()`
= no-op (runner tự clean).

#### Scenario: fetch_file tool đọc file từ cwd

- GIVEN CI runner đã checkout source branch vào `process.cwd()`
- WHEN AI reviewer gọi `fetch_file(path)`
- THEN tool đọc file từ `process.cwd()` (path traversal guard vẫn áp dụng)

### Requirement: Config schema + env boundary

Hệ thống MUST dùng `.pi/config.yaml` là nguồn config duy nhất (declarative, versioned).
Env MUST chỉ chứa secrets (`GITLAB_TOKEN`, LLM keys, `EXA_API_KEY`) + CI runtime context.
Operational knobs `DEFAULT_MODEL`, `MAX_TOOL_CALLS_PER_REVIEW`, `REVIEW_TIMEOUT_MS` MUST
KHÔNG còn đọc từ env — chuyển sang `review.limits` (`maxToolCalls`, `timeoutMs`) và
`llm.model` trong config.yaml. Hệ thống MUST bỏ `ci.*` (`ci.require`, `ci.waitTimeoutMs`
— CI native lo). Nếu gặp `ci.*` legacy, hệ thống SHOULD ignore + log warn (không crash).

#### Scenario: Config có ci.* legacy

- GIVEN `.pi/config.yaml` vẫn chứa `ci.require: true` (user chưa clean)
- WHEN `loadConfig()` parse
- THEN ignore key `ci.*` + log warn "`ci.*` no longer used — CI native handles wait" + review chạy bình thường

#### Scenario: review.limits tùy chỉnh

- GIVEN `.pi/config.yaml` có `review.limits: { maxToolCalls: 50, timeoutMs: 600000 }`
- WHEN `loadConfig()` parse + review chạy
- THEN Pi review dùng tool budget 50 + timeout 10min (thay vì default 30/5min)

#### Scenario: Knobs không còn ở env

- GIVEN env có set `MAX_TOOL_CALLS_PER_REVIEW=50` (user quên move sang config)
- WHEN review chạy
- THEN bot IGNORE env knob + dùng default 30 (hoặc giá trị `review.limits` từ config.yaml) — knobs chỉ đọc từ config

### Requirement: Stats emit stdout JSON line

Hệ thống SHOULD emit đúng 1 JSON line mỗi review lên stdout (per-project observability).
MUST NOT expose HTTP `/stats` endpoint. Trường JSON tối thiểu: `project`, `mrIid`,
`sourceSha`, `outcome`, `durationMs`, `timestamp`.

#### Scenario: Review xong emit 1 dòng

- GIVEN review hoàn tất
- WHEN CLI trước exit
- THEN stdout có 1 dòng JSON chứa các trường tối thiểu

### Requirement: Local debug mode

Hệ thống MAY hỗ trợ chạy manual ngoài CI khi `LOCAL_REPO_PATH` set (repoDir fallback
thay vì `process.cwd()`). Phase design đặc chi tiết flag/env fallback.

#### Scenario: LOCAL_REPO_PATH set

- GIVEN chạy CLI local ngoài CI + `LOCAL_REPO_PATH=/path/to/repo`
- WHEN `mrContextFromEnv()` resolve repoDir
- THEN repoDir = `LOCAL_REPO_PATH` (thay vì `process.cwd()`) để reproduce review local
