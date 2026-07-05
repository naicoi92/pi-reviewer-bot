# Deploy Guide — pi-reviewer-bot

> **Audience**: Dev ops / SRE / self-hoster — người **deploy bot service**.
>
> Nếu bạn muốn **dùng bot cho project GitLab của mình** (không phải deploy),
> xem [INTEGRATION.md](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/INTEGRATION.md) thay vì doc này.

Bot webhook service nhận GitLab MR events → spawn Pi Coding Agent review với LLM
bất kỳ (Z.ai GLM, OpenAI GPT, Anthropic Claude, ...) → post comments + approve/request_changes.

**Deploy anywhere**: Docker container chạy được trên VPS, homelab, Kubernetes, ECS,
hoặc local. Không lock-in cloud cụ thể.

## 0. Prerequisites

| Yêu cầu | Ghi chú |
|---|---|
| Docker 24+ (hoặc Podman, containerd) | Build + run image |
| Z.ai Coding Plan | https://z.ai/subscribe — Lite $12.6/mo đủ |
| GitLab bot account | Personal Access Token scope `api`, role Developer+ |
| Public URL để GitLab gọi webhook | Reverse proxy (Caddy/Nginx) hoặc Cloudflare Tunnel |

---

## 1. Build image (1 lần, hoặc pull từ registry)

### Option A — Build local

```bash
git clone https://github.com/naicoi92/pi-reviewer-bot.git
cd pi-reviewer-bot

# Build multi-arch hoặc single-arch
docker build -t pi-reviewer-bot:latest .

# Verify
docker images pi-reviewer-bot --format "{{.Repository}}:{{.Tag}} — {{.Size}}"
# → pi-reviewer-bot:latest — ~115MB
```

Image là **multi-stage Alpine**:
- Builder: `oven/bun:1.1-alpine` → `bun build --compile` ra standalone binary (~100MB)
- Runtime: `alpine:3.20` + git + ca-certificates → final ~115MB

### Option B — Pull từ GHCR (nếu đã setup GitHub Actions)

```bash
docker pull ghcr.io/naicoi92/pi-reviewer-bot:latest
```

---

## 2. Cấu hình env vars

Copy `.env.example` → `.env`, điền 3 giá trị bắt buộc:

```bash
cp .env.example .env

# 3 biến bắt buộc:
WEBHOOK_SECRET=$(openssl rand -hex 16)  # random 32 chars
GITLAB_API_TOKEN=glpat-xxxxxxxxxxxxxxxx  # bot PAT, scope: api
ZAI_API_KEY=<key từ https://z.ai/console>
```

Lưu giá trị `WEBHOOK_SECRET` — phải khớp với GitLab webhook config sau.

---

## 3. Run container

### Option A — Docker run (đơn giản nhất)

```bash
docker run -d \
  --name pi-reviewer-bot \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v pi-reviews-cache:/tmp/pi-reviews \
  -v pi-agent-cache:/tmp/pi-agent \
  pi-reviewer-bot:latest

# Verify
docker logs pi-reviewer-bot -f
# Thấy: "🤖 pi-reviewer-bot v0.2.0 listening on :3000"

curl http://localhost:3000/healthz
# → {"ok":true,"version":"0.2.0","uptime":...}
```

### Option B — Docker Compose (khuyến nghị production)

```bash
# Đã có docker-compose.yml sẵn trong repo
docker compose up -d

# Logs
docker compose logs -f

# Stop
docker compose down

# Update image mới
docker compose pull && docker compose up -d
```

`docker-compose.yml` có sẵn:
- Restart policy `unless-stopped`
- Healthcheck 30s
- Memory limit 512MB
- Volume cache repo clone (speed up re-review)

### Option C — Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pi-reviewer-bot
spec:
  replicas: 1
  selector:
    matchLabels: { app: pi-reviewer-bot }
  template:
    metadata:
      labels: { app: pi-reviewer-bot }
    spec:
      containers:
        - name: bot
          image: ghcr.io/naicoi92/pi-reviewer-bot:latest
          ports: [{ containerPort: 3000 }]
          envFrom:
            - secretRef: { name: pi-reviewer-bot-secrets }
          resources:
            limits: { memory: "512Mi", cpu: "1000m" }
          livenessProbe:
            httpGet: { path: /healthz, port: 3000 }
            periodSeconds: 30
          volumeMounts:
            - { name: reviews, mountPath: /tmp/pi-reviews }
      volumes:
        - name: reviews
          emptyDir: {}
---
apiVersion: v1
kind: Secret
metadata:
  name: pi-reviewer-bot-secrets
type: Opaque
stringData:
  WEBHOOK_SECRET: "<random>"
  GITLAB_API_TOKEN: "glpat-..."
  ZAI_API_KEY: "<zai-key>"
---
apiVersion: v1
kind: Service
metadata:
  name: pi-reviewer-bot
spec:
  selector: { app: pi-reviewer-bot }
  ports: [{ port: 80, targetPort: 3000 }]
```

### Option D — systemd (VPS không Docker)

Nếu VPS có Bun 1.1+:

```bash
# Build binary local

bun install
bun build --compile --outfile=/usr/local/bin/pi-reviewer-bot ./src/index.ts
```

```ini
# /etc/systemd/system/pi-reviewer-bot.service
[Unit]
Description=pi-reviewer-bot
After=network.target

[Service]
Type=simple
User=pi-bot
EnvironmentFile=/etc/pi-reviewer-bot.env
ExecStart=/usr/local/bin/pi-reviewer-bot
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now pi-reviewer-bot
sudo journalctl -u pi-reviewer-bot -f
```

---

## 4. Expose public URL (cho GitLab gọi webhook)

GitLab.com cần URL public để POST webhook tới. Có 3 cách:

### Cách A — Reverse proxy (VPS có public IP)

```caddyfile
# /etc/caddy/Caddyfile
pi-bot.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Caddy auto-HTTPS qua Let's Encrypt. Webhook URL: `https://pi-bot.yourdomain.com/webhook`

### Cách B — Cloudflare Tunnel (VPS không public IP)

```bash
# Cài cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
cloudflared tunnel --url http://localhost:3000
# → expose nhanh: https://random-name.trycloudflare.com

# Hoặc persistent:
cloudflared tunnel create pi-bot
cloudflared tunnel route dns pi-bot pi-bot.yourdomain.com
```

### Cách C — localtunnel (dev only)

```bash
npx localtunnel --port 3000
# → https://pi-bot.loca.lt
```

---

## 5. Add bot cho GitLab project

Cho mỗi project muốn AI review:

```
GitLab project → Settings → Webhook
```

| Trường | Giá trị |
|---|---|
| **URL** | `https://pi-bot.yourdomain.com/webhook` |
| **Secret token** | `<WEBHOOK_SECRET từ .env>` |
| **Trigger** | ✅ **Merge request events** (bắt buộc) |
|  | ✅ **Pipeline events** (chỉ khi project dùng `ci.require: true` — CI wait mode) |
| **SSL verification** | ✅ Enable |
| **Enable SSL verification** | ✅ |

Click **Add webhook**. Cuộn xuống webhook vừa tạo → **Test → Merge request events**.

Verify bot nhận được (check `docker logs pi-reviewer-bot | grep "webhook"`).

> ℹ️ "Pipeline events" chỉ cần khi project bật `ci.require: true` trong `.pi/config.yaml` (xem section 6). Bình thường chỉ cần "Merge request events".

---

## 6. (Tùy chọn) Project config `.pi/config.yaml`

Tạo file `.pi/config.yaml` trong repo project để customise:

```yaml
review:
  language: vi

scope:
  enabled: true
  convention: "feat/T-XX-*"
  resolvesPattern: "Resolves: #(\\d+)"
  taskIndex: docs/design/07-roadmap.md

block:
  enabled: true  # block merge cho đến khi bot approve

# ci:
#   require: true           # bật CI wait mode — bot đợi CI pass mới review
#   waitTimeoutMs: 900000   # timeout per-project (ms), default = env CI_WAIT_TIMEOUT_MS
```

Commit + push. Bot tự load ở lần review tiếp theo (clone source branch).

> ℹ️ Khi bật `ci.require: true`, **phải enable thêm "Pipeline events" webhook** (xem section 5). Chi tiết: [`docs/CONFIG.md#ci-integration`](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/CONFIG.md#ci-integration).

---

## 7. (Tùy chọn) Enable merge gate

Để MR bị block cho đến khi bot approve:

### 7.1 Project-side

```yaml
# .pi/config.yaml
block:
  enabled: true
```

### 7.2 GitLab Approval Rule

```
Project → Settings → Merge requests → Approval rules → Add rule
  Name: AI Review (pi-bot)
  Approvals required: 1
  Approvers: @<bot-account>
```

Workflow:
- MR mở → bot unapprove → blocked
- Bot review APPROVE → bot approve → unblocked
- Push commit mới → GitLab reset approval → bot re-review

---

## 8. Update bot

```bash
git pull
docker compose build
docker compose up -d
```

Rolling restart, zero downtime nếu dùng K8s.

---

## 9. Monitoring

### Logs

```bash
docker logs pi-reviewer-bot -f --tail 100
```

Mỗi review log:
```
[review !42] start — group/project @ feat/login
[review !42] acquired review slot
[review !42] cloned to /tmp/pi-reviews/... (config: true)
[review !42] ci: pipeline running — enqueued, will review on pipeline success (timeout 600000ms)   ← chỉ khi ci.require=true
[review !42] fetched 8 file diffs
[review !42] pi finished in 48200ms — ok=true events=12
[review !42] tool state: summary=true inline=3 critical=0 approved=true changesRequested=false
[review !42] done — outcome=approved duration=51200ms
```

Pipeline webhook trigger (chỉ khi ci.require=true):
```
[webhook] pipeline success 100@abc12345 — triggering deferred review for !42
```

### Stats endpoint

```bash
# Public (mặc định)
curl http://localhost:3000/stats | jq .

# Hoặc protect bằng STATS_AUTH_TOKEN
curl -H "Authorization: Bearer $STATS_AUTH_TOKEN" http://localhost:3000/stats
```

```json
{
  "global": {
    "totalReviews": 247,
    "totalErrors": 3,
    "projectsTracked": 4
  },
  "projects": [
    {
      "projectPath": "lttech-ga/live-stream",
      "total": 142,
      "byOutcome": { "approved": 120, "unapproved": 19, "skipped": 1, "error": 2 },
      "avgDurationMs": 48200,
      "successRate": 84.5
    }
  ]
}
```

---

## 10. Cost estimate

| Resource | Cost |
|---|---|
| VPS (1 vCPU, 1GB RAM) | $4-10/mo (Hetzner, Vultr, DigitalOcean) |
| Z.ai Coding Plan Lite | $12.6/mo |
| Domain (nếu mua) | $10/year |
| Cloudflare Tunnel | Free |
| **Total** | **~$17-23/mo** |

---

## 11. Troubleshooting

### Webhook không trigger

```bash
# Check bot nhận được không
docker logs pi-reviewer-bot 2>&1 | grep webhook

# Nếu không có log → check GitLab:
# Project → Settings → Webhook → "Recent events" xem có 4xx/5xx không
```

### Bot trả 401

`X-Gitlab-Token` sai → check `WEBHOOK_SECRET` trong `.env` khớp GitLab webhook config.

### Bot 200 nhưng không có comment

```bash
docker logs pi-reviewer-bot 2>&1 | grep "review !"
# Trace từ [review !XX] start đến done
```

Thường:
- `pi finished ... ok=false` → ZAI_API_KEY sai hoặc Coding Plan hết quota
- `failed to post comment` → GITLAB_API_TOKEN sai scope/hết hạn

### Review timeout

```bash
# Tăng timeout trong .env
REVIEW_TIMEOUT_MS=600000  # 10 phút
docker compose up -d
```

### Review bị skip vì CI fail (CI wait mode)

Khi project bật `ci.require: true` và CI fail, bot post note "🚫 CI failed" và skip review. Log:

```
[review !42] ci: pipeline failed — skip review (CI failed)
```

Fix: fix CI ở source branch rồi push commit mới → bot re-check pipeline status.

### Bot không review dù CI pass

Có 3 nguyên nhân thường gặp:

1. **"Pipeline events" webhook chưa enable** — bot enqueue pending nhưng không nhận signal CI finish. Check `Project → Webhook → Trigger` có tick ✅ Pipeline events không.
2. **`ci.require: false` (chưa bật)** — bot review ngay khi MR webhook đến, không đợi CI. Set `ci.require: true` trong `.pi/config.yaml`.
3. **Bot restart giữa lúc đang đợi** — pending lost (in-memory). Push commit để retry.

Để debug, check `/stats` endpoint — field `ciWait.pending` cho biết bao nhiêu review đang đợi CI.

### OOM crash

```bash
# Giảm concurrency hoặc tăng memory limit
MAX_CONCURRENT_REVIEWS=2  # trong .env

# Hoặc tăng compose memory limit
# docker-compose.yml → deploy.resources.limits.memory: 1G
```

---

## 12. Disable bot

```bash
docker compose down  # stop container
# Hoặc xóa webhook trong GitLab project settings
```

---

## Tài liệu tham khảo

- [Pi Coding Agent](https://pi.dev/docs/)
- [Z.ai Coding Plan](https://z.ai/subscribe)
- [Project config schema](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/CONFIG.md)
- [Architecture](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/ARCHITECTURE.md)
- [Multi-project ops](https://github.com/naicoi92/pi-reviewer-bot/blob/main/docs/MULTIPROJECT.md)
