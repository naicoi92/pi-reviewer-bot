# Plan: fetch_url thống nhất (custom pipeline, cherry-pick 12 features)

> Status: chờ approval. Sau khi duyệt → implement.

## Mục tiêu

Gộp ưu điểm fetch_url (custom) + fetch_content (pi-web-access) thành **1 tool duy nhất**,
cherry-pick đúng 12 features user chọn. **KHÔNG** dùng `fetchAllContent` (bundle
YouTube/PDF/Gemini/GitHub-clone — user skip). Build self-contained, minimal deps.

## Spec (12 lựa chọn đã duyệt)

| # | Feature | Quyết |
|---|---|---|
| 1 | URL count | Multi-URL parallel (`url: string \| string[]`) — **tool rename `fetch_url` → `fetch_urls`** |
| 2 | Extraction | Readability → markdown (@mozilla/readability + linkedom + turndown) |
| 3 | SPA/JS | Jina Reader fallback (r.jina.ai, free, no key) — khi Readability trả rỗng/ngắn |
| 4 | GitHub repo | Raw file URL (no clone) — fetch URL thẳng |
| 5 | YouTube | Skip |
| 6 | Video/PDF | Skip |
| 7 | SSRF | DNS-resolve + check public IP (validateRemoteUrl) |
| 8 | Size cap | Truncate inline + retrieve full qua get_search_content |
| 9 | Timeout | 15s default + param `timeoutMs?` override |
| 10 | Storage | **Store MỌI result** (revised — không chỉ oversized) → file, return responseId mỗi call |
| 11 | Multimodal | Text only |
| 12 | Deps | Bun native fetch (HTTP/2 auto), drop pi-web-access, self-contained |

## Implementation

### 1. Nâng cấp `src/ssrf.ts`

Thêm `validateRemoteUrl(rawUrl): Promise<URL>` — DNS-resolve + check public IP.
Port logic từ `pi-web-access/ssrf-protection.ts` (~60 dòng, stdlib only: node:dns, node:net).
Giữ `assertSafeUrl` cũ (web_search.ts vẫn dùng, backward compat).

```
validateRemoteUrl(url):
  - protocol phải http/https
  - block localhost/.localhost
  - resolve DNS → check mỗi IP isPublic (block private/reserved/loopback/link-local)
  - trả URL nếu pass, throw nếu fail
```

### 2. Rewrite `src/tools/fetch_urls.ts` (rename từ fetch_url.ts)

Custom pipeline (KHÔNG import pi-web-access):

```
fetch_urls(url: string | string[], timeoutMs?: number)
  generate responseId (randomUUID)
  per URL (parallel, p-limit concurrency 3):
    1. validateRemoteUrl (SSRF DNS-resolve)
    2. fetchRemoteUrl (Bun HTTP/2, redirect re-validated) — Accept text/html
    3. Readability (linkedom parseHTML → Readability.parse → Turndown → markdown)
    4. If markdown rỗng/quá ngắn (<200 chars, dấu JS-rendered) → Jina fallback:
       GET https://r.jina.ai/<url> (Accept: text/markdown) → markdown
    5. Thu thập { url, title, content, error? }
  Store MỌI result → $PI_AGENT_DIR/fetch-cache/<responseId>.json
  Return inline (truncate từng content >cap) + responseId
```

Timeout: `AbortSignal.timeout(params.timeoutMs ?? 15000)` per fetch.

### 3. Tool mới `src/tools/get_search_content.ts`

```
get_search_content(responseId, urlIndex?: number)
  - read $PI_AGENT_DIR/fetch-cache/<responseId>.json
  - urlIndex? → return content của URL cụ thể; omit → return tất cả
  - error nếu responseId không tồn tại
```

### 4. package.json

- Add deps: `@mozilla/readability`, `linkedom`, `turndown`, `p-limit`
- Remove: `pi-web-access` (drop — build self-contained)
- `bun install`

### 5. Đăng ký tool

- `src/tools/index.ts`: thêm `getSearchContentTool` vào createReviewTools (12 → 13 tools)
- `test/tools.test.ts`: update "registers exactly 13 tools"

### 6. Docs

- `agents/code-reviewer.md`: update fetch_url description (Readability + Jina fallback + multi-URL), add get_search_content row
- `AGENTS.md`: tool count 13, Web Lookup section, D20 update (revised approach: custom pipeline, drop extension)

## Tradeoffs

- **Plus**: đúng spec user chọn, minimal deps, self-contained, binary nhỏ, no yt-dlp/ffmpeg
- **Minus**: maintain Readability+Jina+SSRF logic ourselves (vs upstream fetchAllContent). ~150 dòng code mới.
- **Risk**: Jina Reader là 3rd-party proxy (r.jina.ai) — uptime không controlled. Fallback only, không critical path.

## Verification

- typecheck pass
- bun test pass (update tool count test)
- Manual: `bun -e 'fetch_url(["https://example.com", "https://npmjs.com/package/lodash"])'` smoke test
- Real SSRF: fetch <http://127.0.0.1> → blocked
- Jina fallback: fetch SPA page → markdown non-empty

## Không làm

- Không load pi-web-access extension (revert noExtensions=false)
- Không thêm YouTube/PDF/Gemini/GitHub-clone (user skip)
- Không text-parse verdict (D3 tool-based giữ nguyên)
