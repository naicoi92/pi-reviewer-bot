# Contributing to pi-reviewer-bot

Cảm ơn bạn quan tâm đóng góp! Đây là hướng dẫn ngắn để bắt đầu.

## 🚀 Quick Start

```bash
git clone https://github.com/naicoi92/pi-reviewer-bot.git
cd pi-reviewer-bot

cd bot
bun install
cp ../.env.example ../.env  # điền ZAI_API_KEY + GITLAB_API_TOKEN
bun run dev                  # hot reload tại localhost:3000
```

## 🛠 Development

### Code style

- **TypeScript strict mode** — `bun run typecheck` phải pass
- **ESM only** (`"type": "module"`)
- **No `any`** — dùng `unknown` + type guard
- Comments tiếng Việt cho business logic, identifier tiếng Anh
- JSDoc cho mọi public export

### Trước khi commit

```bash
cd bot
bun run typecheck   # phải clean
bun test            # tất cả pass
```

### Tests

- Framework: `bun:test` (built-in)
- File: `*.test.ts` cùng folder source hoặc trong `test/`
- Mỗi bug fix PHẢI có regression test

```bash
bun test                # run all
bun test --watch        # watch mode
bun test tools          # filter
```

## 📝 Commit Convention

Dùng [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:
- `feat` — feature mới
- `fix` — bug fix
- `refactor` — code change không đổi behavior
- `docs` — documentation
- `chore` — config, deps, CI
- `test` — thêm/sửa test

Ví dụ:
```
feat(tools): thêm list_mr_commits tool cho iteration context
fix(webhook): race condition khi stats.record trước post-approve
docs(setup): rewrite deploy guide cho Docker
```

## 🔄 Pull Request Workflow

1. **Fork** repo + clone fork của bạn
2. Tạo branch: `git checkout -b feat/ten-feature`
3. Code + test + typecheck
4. Commit theo conventional format
5. Push lên fork: `git push origin feat/ten-feature`
6. Mở PR vào `main` của repo gốc

### PR checklist

- [ ] `bun run typecheck` clean
- [ ] `bun test` pass
- [ ] Commit message theo conventional format
- [ ] Nếu thêm tool/feature → update agent prompt + docs
- [ ] Nếu fix bug → có regression test

## 🏗 Architecture decisions

Trước khi propose change lớn, đọc [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — có decision log (D1-D8) giải thích lý do các lựa chọn kỹ thuật.

Nếu thay đổi architecture → thêm decision D9, D10... vào log.

## 🐛 Report bug

Mở [GitHub Issue](https://github.com/naicoi92/pi-reviewer-bot/issues/new) với:

1. **Mô tả ngắn** vấn đề
2. **Steps to reproduce** (code hoặc webhook payload)
3. **Expected vs actual behavior**
4. **Logs** từ `docker logs pi-reviewer-bot`
5. **Environment**: Docker version, image tag, GitLab version

## 💡 Request feature

Mở issue với label `enhancement`. Mô tả:
- **Use case** cụ thể (không chỉ "I want X")
- **Alternatives đã consider**
- **Mockup/API sketch** nếu có

## 📦 Release process

Maintainer làm:

1. Update version trong `bot/package.json`
2. Update `CHANGELOG.md` (nếu có)
3. Tag: `git tag v0.X.Y && git push --tags`
4. GitHub Actions auto-build + push image lên GHCR với tag `v0.X.Y` + `latest`

## 🤝 Code of Conduct

- Tôn trọng mọi người trong issue/PR/discussion
- Review constructive, không personal attack
- Welcome newcomers — giúp đỡ nếu có câu hỏi

## 📧 Liên hệ

- GitHub Issues: [naicoi92/pi-reviewer-bot/issues](https://github.com/naicoi92/pi-reviewer-bot/issues)
- GitHub Discussions: [naicoi92/pi-reviewer-bot/discussions](https://github.com/naicoi92/pi-reviewer-bot/discussions)

Cảm ơn đóng góp của bạn! 🎉
