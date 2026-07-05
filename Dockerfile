# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# pi-reviewer — CI image cho GitLab CI / GitHub Actions
#
# Image Docker dùng chung cho CI review với Pi + Z.ai GLM Coding Plan.
# Tích hợp sẵn:
#   - Node 22 (LTS)
#   - Pi CLI (@earendil-works/pi-coding-agent npm package)
#   - glab CLI (GitLab CLI để post MR comment)
#   - git, curl, jq, ca-certificates
#
# Image base: node:22-slim (Debian Bookworm)
# Target: chạy trên GitLab CI runner + GitHub Actions runner
# ─────────────────────────────────────────────────────────────

FROM node:22-slim AS base

# Build-time args (cho phép pin version khi build)
ARG PI_VERSION=latest
ARG GLAB_VERSION=1.106.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PI_CACHE_DIR=/cache/pi \
    PATH=/usr/local/bin:/opt/glab:$PATH

# ─── 1. System packages ──────────────────────────────────────
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        tar \
        gzip \
        xz-utils \
        file \
    && rm -rf /var/lib/apt/lists/*

# ─── 2. Install glab CLI từ GitLab package repo (ổn định hơn release URL) ────
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
        amd64)  GLAB_ARCH=amd64  ;; \
        arm64)  GLAB_ARCH=arm64  ;; \
        *)      echo "Unsupported arch: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${GLAB_ARCH}.deb" \
        -o /tmp/glab.deb \
    && apt-get install -y --no-install-recommends /tmp/glab.deb \
    && rm /tmp/glab.deb \
    && glab version

# ─── 3. Install Pi CLI ───────────────────────────────────────
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" --omit=dev \
    && npm cache clean --force \
    && (pi --version 2>&1 || echo "pi installed (no --version flag)")

# ─── 4. Setup non-root user (GitLab CI / GH Actions best practice) ──
RUN useradd --create-home --shell /bin/bash --uid 1000 reviewer \
    && mkdir -p /cache/pi /work \
    && chown -R reviewer:reviewer /cache /work

USER reviewer
WORKDIR /work

# ─── 5. Default entrypoint ───────────────────────────────────
ENTRYPOINT []
CMD ["pi", "--help"]
