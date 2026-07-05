# Changelog

Tất cả notable changes đến pi-reviewer-bot được ghi ở đây.
Format dựa trên [Keep a Changelog](https://keepachangelog.com/),
versioning theo [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Initial public release preparation

### Fixed
- **BUG 5: CI wait mode stuck "running" vì SHA asymmetry** — `mrContextFromWebhook` không fallback `last_commit.id` khi `source_branch_sha` undefined (xảy ra ở open/reopen event, nhiều GitLab self-managed). `getMrPipelineStatus` filter theo SHA undefined → lấy tất cả pipelines của MR kể cả zombie cũ running → aggregate "running" → bot enqueue đợi → stuck. Fix: thống nhất fallback `source_branch_sha ?? last_commit.id` ở 3 chỗ (ciwait, inflight, mrContextFromWebhook) + log warn khi vẫn undefined.
- **BUG 6: Pipeline webhook handler thiếu logging** — 3 skip path silent (`status !== "success"`, missing project_id/sha, no pending entry) không có log → không debug được "CI pass nhưng bot không review". Fix: thêm `[webhook] pipeline skip <project>@<short-sha> — <reason>` consistent với MR webhook log.

## [0.2.0] — 2026-07-05

### Added
- **Mức 3 Full Tool architecture** — AI có 10 tools (fetch_file, get_issue, list_mr_comments, list_mr_commits, list_wiki_pages, get_wiki_page, post_inline_comment, post_summary, approve_mr, request_changes)
- **Pi Coding Agent SDK in-process** — thay OpenCode subprocess
- **Inline DiffNote** qua GitLab Discussions API với position hash
- **Merge gate** qua GitLab Approval API (approve/unapprove)
- **Multi-project** — 1 bot instance phục vụ mọi GitLab project qua `.pi/config.yaml`
- **Stats endpoint** `/stats` — per-project observability
- **Concurrency + rate limit** — semaphore 3 + 10s cooldown/project
- **Guardrail approve_mr** — block nếu chưa post_summary hoặc có critical unresolved
- **Fail-safe** — bot unapprove nếu AI crash trước khi gọi verdict tool
- **Token redaction** trong logs (chống leak oauth2:TOKEN@)
- **Path traversal guard** trong fetch_file (realpath)
- **Line validation** trong post_inline_comment (parse @@ hunk headers)
- **Multi-stage Docker build** — Bun alpine builder + alpine runtime, ~115MB
- **Multi-arch images** (amd64 + arm64) qua GitHub Actions buildx
- **docker-compose.yml** cho production deploy
- **AGENTS.md** — context cho AI maintainer
- **INTEGRATION.md** — guide cho AI consumer setup project
- 22 unit tests covering token verify, action filter, config merge, tool state

### Changed
- Default LLM: `zai/glm-5.2` (Z.ai Coding Plan, $12.6/mo)
- Image name: `pi-reviewer-bot` (trước: `opencode-reviewer-image`)

### Removed
- OpenCode subprocess integration (thay bằng Pi SDK)
- Fly.io deploy config (thay bằng Docker anywhere)
- `parseVerdict` regex (thay bằng tool call intent)
