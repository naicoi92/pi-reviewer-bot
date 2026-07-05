/**
 * web_search tool — AI tra cứu thông tin mới nhất trên internet.
 *
 * Use cases (xem "Web Lookup" section trong agents/code-reviewer.md):
 *   - Package version: "axios latest version", "react 19 release date"
 *   - API deprecation: "express 5 breaking changes", "node 22 deprecated apis"
 *   - CVE lookup: "lodash 4.17.4 cve"
 *   - Pattern verification: "bun spawn typescript example"
 *
 * Backend priority:
 *   1. Exa (cần EXA_API_KEY) — quality cao cho code/API docs
 *   2. DuckDuckGo HTML (free, no key) — fallback nếu Exa không có/không dùng được
 *
 * Implementation dùng Bun native `fetch()` với HTTP/2 auto-negotiation.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { assertSafeUrl } from "../ssrf.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = "pi-reviewer-bot/0.3.0 (+https://github.com/naicoi92/pi-reviewer-bot)";

const MAX_RESULTS_CAP = 10;
const DEFAULT_MAX_RESULTS = 5;
/** Cap mỗi result snippet — tránh 1 result chiếm trọn context window. */
const SNIPPET_MAX_CHARS = 500;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Decode HTML entities common trong DDG HTML response. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Format search results cho LLM consumption. */
function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results found for: "${query}"`;
  }
  const lines = [`# Search results for: "${query}"`, `${results.length} results`, ``];
  results.forEach((r, i) => {
    const snippet = r.snippet.length > SNIPPET_MAX_CHARS
      ? r.snippet.slice(0, SNIPPET_MAX_CHARS) + "..."
      : r.snippet;
    lines.push(`## ${i + 1}. ${r.title}`);
    lines.push(`URL: ${r.url}`);
    lines.push(``);
    lines.push(snippet);
    lines.push(``);
  });
  return lines.join("\n").trim();
}

/**
 * Search qua Exa API — quality cao cho code/API docs.
 * Doc: https://docs.exa.ai/reference/search
 */
async function searchExa(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("EXA_API_KEY not set");

  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      query,
      numResults: Math.min(maxResults, MAX_RESULTS_CAP),
      // Exa returns contents nếu type="neural" — ta chỉ cần metadata để tránh token bloat
      type: "auto",
      contents: {
        text: { maxCharacters: SNIPPET_MAX_CHARS },
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Exa HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    results?: Array<{ title?: string; url?: string; text?: string; score?: number }>;
  };
  return (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title?.trim() || r.url || "(untitled)",
      url: r.url!,
      snippet: (r.text ?? "").trim(),
    }));
}

/**
 * Search qua DuckDuckGo HTML endpoint — free, no API key.
 * Parse regex trên `result__a` (link) + `result__snippet` (description).
 *
 * Note: DDG HTML format khá stable nhưng không officially supported.
 * Nếu format break → return empty result (fail-open), AI fallback training data.
 */
async function searchDdg(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  // SSRF guard (defensive — DDG URL hard-coded public, nhưng consistent pattern)
  const check = assertSafeUrl(url);
  if (!check.ok) throw new Error(`DDG URL blocked: ${check.error}`);

  const resp = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!resp.ok) {
    throw new Error(`DDG HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const results: SearchResult[] = [];

  // DDG HTML pattern (empirical 2024-2025):
  //   <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded-url>...">Title</a>
  //   <a class="result__snippet" href="...">Snippet text</a>
  // Split theo result block để match link + snippet cùng 1 result.
  const blocks = html.split(/<div class="result results_links[^"]*">/i).slice(1);

  for (const block of blocks) {
    if (results.length >= maxResults) break;

    // Extract title + real URL (DDG wrap qua redirect endpoint với uddg= param)
    const linkMatch = block.match(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch || !linkMatch[1] || !linkMatch[2]) continue;
    const rawHref = decodeEntities(linkMatch[1]);
    const title = decodeEntities(linkMatch[2].replace(/<[^>]+>/g, "")).trim();

    // Resolve uddg= redirect param
    let realUrl = rawHref;
    const uddg = rawHref.match(/[?&]uddg=([^&]+)/);
    if (uddg && uddg[1]) {
      try {
        realUrl = decodeURIComponent(uddg[1]);
      } catch {
        // keep raw
      }
    }

    // Extract snippet
    const snippetMatch = block.match(
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const snippet = snippetMatch && snippetMatch[1]
      ? decodeEntities(snippetMatch[1].replace(/<[^>]+>/g, "")).trim()
      : "";

    if (title && realUrl) {
      results.push({ title, url: realUrl, snippet });
    }
  }

  return results;
}

export function webSearchTool(_ctx: ToolContext) {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the internet for up-to-date information: package versions, API docs, CVEs, " +
      "deprecation notices, breaking changes. Uses Exa if EXA_API_KEY set, else DuckDuckGo. " +
      "Returns title + URL + snippet per result — call fetch_url on the most relevant to read full content.",
    promptSnippet:
      "web_search(query, maxResults?): search internet. Trigger: dep version mismatch, " +
      "outdated dependency, API deprecated/sai signature, CVE lookup.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query in natural language. Be specific — include package name + version " +
          "(e.g. 'lodash 4.17.4 CVE', 'react 19 use() hook API', 'axios latest version').",
      }),
      maxResults: Type.Optional(
        Type.Number({
          description: `Max results to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_CAP}).`,
          minimum: 1,
          maximum: MAX_RESULTS_CAP,
        }),
      ),
    }),
    async execute(_id, params) {
      const query = params.query.trim();
      if (!query) {
        return err("Query is empty");
      }
      const maxResults = Math.min(
        Math.max(params.maxResults ?? DEFAULT_MAX_RESULTS, 1),
        MAX_RESULTS_CAP,
      );

      // Try Exa first (if key configured), fallback DuckDuckGo
      const useExa = Boolean(process.env.EXA_API_KEY);
      const results: SearchResult[] = [];
      let backend: string;

      if (useExa) {
        try {
          results.push(...(await searchExa(query, maxResults)));
          backend = "exa";
        } catch (e) {
          // Exa fail (rate limit, network, bad key) → fallback DDG transparent
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[web_search] Exa failed (${msg}); falling back to DuckDuckGo`);
          try {
            results.push(...(await searchDdg(query, maxResults)));
            backend = "duckduckgo (exa-failed)";
          } catch (e2) {
            const msg2 = e2 instanceof Error ? e2.message : String(e2);
            return err(`Search failed (exa+ddg): ${msg} | ${msg2}`);
          }
        }
      } else {
        try {
          results.push(...(await searchDdg(query, maxResults)));
          backend = "duckduckgo";
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return err(`DuckDuckGo search failed: ${msg}. Set EXA_API_KEY for backup backend.`);
        }
      }

      return ok(formatResults(query, results), {
        query,
        backend,
        count: results.length,
      });
    },
  });
}
