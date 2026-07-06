/**
 * fetch_url tool — AI đọc nội dung 1 URL để verify context.
 *
 * Use cases (xem "Web Lookup" section trong agents/code-reviewer.md):
 *   - Đọc npmjs.com package page để check version mới nhất
 *   - Đọc MDN / official docs để verify API signature đúng version
 *   - Đọc GitHub SECURITY advisory cho CVE lookup
 *   - Đọc changelog để check breaking changes giữa versions
 *
 * Implementation dùng Bun native `fetch()` — built-in HTTP/2 qua ALPN,
 * không cần thêm dependency. Connection pool + TLS handled bởi Bun internals.
 *
 * SSRF guard: assertSafeUrl block private IP literals + non-http(s) protocols
 * trước khi fetch (xem src/ssrf.ts).
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { assertSafeUrl } from "../ssrf.ts";
import { withTimeout } from "../http.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

/** Cap response body — tránh fetch 100MB changelog blowing up bot memory. */
const MAX_BYTES = 100_000; // 100KB
/** Network timeout — chống hang khi server slow/unresponsive. */
const FETCH_TIMEOUT_MS = 15_000;
/** UA — không bị bot-block bởi npmjs.com, MDN, GitHub docs, ... */
const USER_AGENT = "pi-reviewer-bot/0.3.0 (+https://github.com/naicoi92/pi-reviewer-bot)";

/**
 * Strip HTML tags cơ bản — đủ để đọc text từ docs pages.
 * Không thay thế cheerio/readability — đó là post-MVP nếu cần extract chính xác.
 */
function stripHtml(html: string): string {
  return html
    // Bỏ script/style nội dung (giữ fallback nếu thiếu closing tag)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Block tags → newline (paragraph, heading, list, div, ...)
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr|section|article|header|footer|pre|code|table)\s*>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    // Bỏ tất cả remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decide có strip HTML hay không dựa trên content-type. */
function isHtmlContentType(contentType: string): boolean {
  return /\b(html|xhtml)\b/i.test(contentType);
}

export function fetchUrlTool(_ctx: ToolContext) {
  return defineTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch and read content from a public URL (https preferred). Use after web_search to read " +
      "the full page, or directly when you know the exact URL (npmjs.com, MDN, GitHub advisory, " +
      "official docs). SSRF-guarded — private/internal IPs blocked. HTML stripped to text.",
    promptSnippet:
      "fetch_url(url): read content from a URL. For verifying package versions, API signatures, CVEs.",
    parameters: Type.Object({
      url: Type.String({
        description:
          "Absolute URL (http/https). Must be publicly reachable — private IPs (127.x, 10.x, 192.168.x, 169.254.x) are blocked.",
      }),
    }),
    async execute(_id, params) {
      const check = assertSafeUrl(params.url);
      if (!check.ok) {
        return err(check.error);
      }

      let resp: Response;
      try {
        resp = await fetch(check.url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            "User-Agent": USER_AGENT,
            // GitHub docs/mdn Returns markdown/plain nếu server hỗ trợ
            "Accept": "text/html,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.5",
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // AbortSignal.timeout throws DOMException name=TimeoutError
        if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("TimeoutError")) {
          return err(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${params.url}`);
        }
        return err(`Fetch failed: ${msg}`);
      }

      if (!resp.ok) {
        return err(`HTTP ${resp.status} ${resp.statusText} — ${params.url}`);
      }

      const contentType = resp.headers.get("content-type") ?? "";

      // Stream-read với size cap — tránh load full body nếu huge
      // Body read wrapped trong withTimeout: AbortSignal của fetch không abort
      // tin cậy arrayBuffer() trong Bun (slowloris-style body hang).
      let raw: string;
      try {
        // Bun supports resp.text() — đọc full rồi slice. Pour performance post-MVP.
        const buf = await withTimeout(
          resp.arrayBuffer(),
          FETCH_TIMEOUT_MS,
          "fetch_url body",
        );
        const truncated = buf.byteLength > MAX_BYTES;
        const slice = truncated ? buf.slice(0, MAX_BYTES) : buf;
        raw = new TextDecoder("utf-8", { fatal: false }).decode(slice);
        if (truncated) {
          raw += `\n\n[... TRUNCATED at ${MAX_BYTES} bytes. Original: ${buf.byteLength} bytes.]`;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Body read failed: ${msg}`);
      }

      const body = isHtmlContentType(contentType) ? stripHtml(raw) : raw;

      return ok(
        `# ${check.url}\nContent-Type: ${contentType || "(unknown)"} | ${body.length} chars\n\n${body}`,
        {
          url: check.url.toString(),
          contentType,
          bytes: body.length,
        },
      );
    },
  });
}
