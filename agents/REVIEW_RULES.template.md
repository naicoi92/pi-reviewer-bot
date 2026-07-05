# Review Rules — <Tên project>

> File này **optional**. Bot tự lo phần hướng dẫn tools + workflow review —
> project KHÔNG cần lặp lại. Chỉ viết info về **project của bạn**.
>
> Bỏ qua section nào không cần. Section dưới chỉ là gợi ý, không bắt buộc.

## Stack

(Ví dụ: Rust 1.75+ strict mode; TypeScript strict no-`any`; Bun runtime;
Python 3.12 type hints bắt buộc; ...)

## Conventions

(Ví dụ:
- Rust: no `unwrap()`/`expect()` ngoài test
- TS: prefer `unknown` + type guard thay vì `any`
- Domain layer không import infra deps (database, HTTP client)
- Error handling qua `Result<T, E>`, không throw)

## Review focus

(Ví dụ:
- Ưu tiên check SQL injection ở repository layer
- Check error boundary cho mọi React component gọi API
- Verify idempotency cho mọi webhook handler
- Concurrency safety cho shared state)

## Policies

(Ví dụ:
- Không dùng GPL/LGPL crate — check license mỗi dependency mới
- Không gọi FFmpeg trực tiếp, chỉ qua approved wrapper
- Secret phải lấy từ env, không hardcode
- Migration script phải có rollback)

## Out of scope

(Ví dụ:
- Không review file trong `vendor/` hoặc `third_party/`
- Không comment style cho `*.test.ts` — chỉ check logic
- Skip docs-only changes trong `docs/design/`)

## Project-specific tools/integrations

(Ví dụ:
- Project dùng Planetscale → check schema migration compatibility
- Project deploy trên Fly.io → check `fly.toml` region config
- Project tích hợp Stripe → verify idempotency key cho mọi payment call)
