# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# pi-reviewer-bot — Dockerfile (multi-stage, Alpine cả builder lẫn runtime)
#
# Build (chạy từ repo root):
#   docker build -t pi-reviewer-bot:latest .
#
# Multi-arch:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/naicoi92/pi-reviewer-bot:latest --push .
#
# Run:
#   docker run --rm -p 3000:3000 \
#     -e WEBHOOK_SECRET=... -e GITLAB_API_TOKEN=... -e ZAI_API_KEY=... \
#     pi-reviewer-bot:latest
#
# Architecture:
#   Stage 1 (builder): oven/bun:1.1-alpine
#     - bun install deps + bun build --compile → standalone binary (~100MB, musl)
#   Stage 2 (runtime): alpine:3.20
#     - apk add git ca-certificates tzdata (~10MB)
#     - Final image ~115MB — có shell để debug, không hardcore như distroless
# ─────────────────────────────────────────────────────────────

# ─── Stage 1: Build standalone binary với Bun --compile ──────
FROM oven/bun:1.1-alpine AS builder

# file utility để verify binary built (debug)
RUN apk add --no-cache file

WORKDIR /build

# Copy manifest + lockfile trước (cache layer)
COPY package.json bun.lockb* ./

# Install deps (production only — đủ cho compile)
RUN bun install --frozen-lockfile --production || bun install --production

# Copy source code + agent prompts
COPY src ./src
COPY agents ./agents
COPY tsconfig.json ./

# Bun trong alpine image tự nhiên target musl libc → binary tương thích
# với alpine runtime. Không cần chỉ định --target (Bun auto-detect platform).
# Multi-arch: buildx sẽ chạy stage này trên mỗi platform riêng, Bun tự build đúng variant.
RUN bun build --compile \
  --minify \
  --outfile=/build/pi-reviewer-bot \
  ./src/index.ts

# Verify binary built
RUN ls -lh /build/pi-reviewer-bot && file /build/pi-reviewer-bot

# ─── Stage 2: Alpine runtime (nhẹ, có shell để debug) ────────
FROM alpine:3.20

# Cài: git (clone repo per-MR), ca-certificates (HTTPS), tzdata (timezone),
# wget (healthcheck), tini (init để handle signal đúng cách),
# libstdc++ + libgcc (Bun binary cần glibc libs — Alpine dùng musl nhưng
# các lib này cung cấp compat layer cho binary compiled với GCC).
RUN apk add --no-cache \
  git \
  curl \
  ca-certificates \
  tzdata \
  wget \
  tini \
  libstdc++ \
  libgcc \
  libc6-compat \
  && update-ca-certificates \
  && addgroup -S -g 1001 bot \
  && adduser -S -D -H -u 1001 -G bot bot \
  && mkdir -p /tmp/pi-reviews /tmp/pi-agent /app \
  && chown -R bot:bot /tmp/pi-reviews /tmp/pi-agent /app

WORKDIR /app

# Copy binary từ builder
COPY --from=builder /build/pi-reviewer-bot /app/pi-reviewer-bot

# Copy agent prompts (runtime đọc khi init Pi session)
COPY --from=builder /build/agents /app/agents

# Đảm bảo binary execute được + ownership đúng
RUN chmod +x /app/pi-reviewer-bot && chown -R bot:bot /app

USER bot

EXPOSE 3000

# Env defaults (override qua `docker run -e` hoặc docker-compose)
ENV PI_AGENT_DIR=/tmp/pi-agent \
  REPO_TMP_ROOT=/tmp/pi-reviews \
  NODE_ENV=production \
  PORT=3000 \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8

# Healthcheck — gọi /healthz mỗi 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

# tini làm init — handle SIGTERM đúng cách khi docker stop
ENTRYPOINT ["/sbin/tini", "--"]

# Standalone binary — không cần `bun run`, gọi trực tiếp
CMD ["/app/pi-reviewer-bot"]
