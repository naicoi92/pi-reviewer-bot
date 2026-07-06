/**
 * fetch_urls — đọc nội dung 1 hoặc nhiều URL, extraction Readability → markdown.
 *
 * Pipeline (custom, self-contained — KHÔNG dùng pi-web-access):
 *   1. `validateRemoteUrl` (SSRF: DNS-resolve + check public IP)
 *   2. `fetchRemoteUrl` (Bun native fetch HTTP/2, redirect re-validated)
 *   3. Readability (linkedom parseHTML → Readability.parse → Turndown → markdown)
 *   4. Jina Reader fallback (r.jina.ai, free, no key) nếu Readability trả rỗng/ngắn
 *
 * Store MỌI result → `$PI_AGENT_DIR/fetch-cache/<responseId>.json`.
 * AI dùng `get_search_content(responseId, urlIndex?)` retrieve lại full content.
 *
 * KHÔNG hỗ trợ (per spec D20): YouTube, PDF, Video, GitHub clone, Gemini fallback.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateRemoteUrl, fetchRemoteUrl } from "../ssrf.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

/** Timeout mặc định mỗi fetch (override qua param `timeoutMs`). */
const FETCH_TIMEOUT_DEFAULT_MS = 15_000;
/** Cap content inline trả cho AI mỗi URL — chống burn token. Full content lưu file. */
const MAX_INLINE_CHARS = 100_000;
/** Ngưỡng Readability output coi là "rỗng/JS-rendered" → thử Jina fallback. */
const READABILITY_MIN_CHARS = 200;
/** Jina Reader proxy (render JS server-side, free, no API key). */
const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30_000;
/** Concurrency cho multi-URL (chống flood). */
const CONCURRENCY = 3;
/** Cache dir = $PI_AGENT_DIR/fetch-cache. */
const FETCH_CACHE_DIR = join(
	process.env.PI_AGENT_DIR ?? "/tmp/pi-agent",
	"fetch-cache",
);
/** UA — không bị bot-block bởi npmjs.com, MDN, GitHub docs, ... */
const USER_AGENT =
	"pi-reviewer-bot/0.3.0 (+https://github.com/naicoi92/pi-reviewer-bot)";

/** Turndown instance (HTML → markdown). Atx heading + fenced code block. */
const TURNDOWN = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

/** Kết quả fetch 1 URL. */
interface FetchedUrl {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

/** Extract HTML → {title, markdown} qua Readability + Turndown. Rỗng nếu fail. */
function readabilityExtract(html: string): { title: string; markdown: string } {
	try {
		const { document } = parseHTML(html);
		const article = new Readability(document as unknown as Document).parse();
		if (!article?.content) return { title: "", markdown: "" };
		return {
			title: article.title ?? "",
			markdown: TURNDOWN.turndown(article.content),
		};
	} catch {
		return { title: "", markdown: "" };
	}
}

/** Jina Reader fallback — fetch r.jina.ai/<url> (render JS server-side). Null nếu fail. */
async function jinaFetch(url: string): Promise<string | null> {
	try {
		const res = await fetch(JINA_READER_BASE + url, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}

/** Fetch + extract 1 URL: SSRF → fetch → Readability → Jina fallback. */
async function fetchOneUrl(
	url: string,
	timeoutMs: number,
): Promise<FetchedUrl> {
	// 1. SSRF validate (DNS-resolve + public IP check)
	await validateRemoteUrl(url);
	// 2. Fetch (redirect-safe, SSRF re-validated mỗi hop)
	const res = await fetchRemoteUrl(url, {
		headers: {
			Accept: "text/html,application/xhtml+xml",
			"User-Agent": USER_AGENT,
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) {
		return {
			url,
			title: url,
			content: "",
			error: `HTTP ${res.status} ${res.statusText}`,
		};
	}
	const html = await res.text();
	// 3. Readability extraction
	const { title, markdown } = readabilityExtract(html);
	// 4. Jina fallback nếu Readability rỗng/ngắn (dấu JS-rendered SPA)
	let content = markdown;
	let finalTitle = title;
	if (markdown.length < READABILITY_MIN_CHARS) {
		const jina = await jinaFetch(url);
		if (jina && jina.length > markdown.length) {
			content = jina;
			if (!finalTitle) finalTitle = url;
		}
	}
	if (!content.trim()) {
		return {
			url,
			title: finalTitle || url,
			content: "",
			error: "Empty content after extraction",
		};
	}
	return { url, title: finalTitle || url, content, error: null };
}

export function fetchUrlsTool(_ctx: ToolContext) {
	return defineTool({
		name: "fetch_urls",
		label: "Fetch URLs",
		description:
			"Đọc NHIỀU URL song song → markdown sạch (1 call = fetch tất cả). " +
			'TRUYỀN ARRAY urls=["...","..."] để fetch nhiều URL cùng lúc — KHÔNG call từng URL riêng. ' +
			"Chấp nhận 1 string làm shorthand cho single URL. " +
			"Extraction: Readability + Jina Reader fallback (SPA/JS-heavy). SSRF guard (DNS-resolve, block private IP). " +
			"Mọi result được lưu — dùng get_search_content(responseId) retrieve full content. " +
			"Dùng sau web_search hoặc khi đã biết URL chính xác.",
		promptSnippet:
			"fetch_urls(urls: string[], timeoutMs?): fetch NHIỀU URL song song trong 1 call (truyền array). Readability + Jina fallback. Luôn batch — KHÔNG call riêng từng URL. Trigger: sau web_search, verify dep/API/CVE docs.",
		parameters: Type.Object({
			url: Type.Union(
				[
					Type.Array(Type.String(), {
						description:
							"Danh sách URL (http/https) — fetch song song. PREFERRED: luôn truyền array kể cả 1 URL.",
					}),
					Type.String({
						description:
							"Shorthand cho 1 URL. Nếu truyền string, internally wrap thành [string].",
					}),
				],
				{
					description:
						"URL(s) cần fetch. ARRAY = primary mode (batch nhiều URL 1 call, song song). " +
						"string = shorthand cho 1 URL. KHÔNG call fetch_urls nhiều lần cho nhiều URL — truyền 1 array.",
				},
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: `Timeout mỗi fetch ms (default ${FETCH_TIMEOUT_DEFAULT_MS}).`,
					minimum: 1000,
				}),
			),
		}),
		async execute(_id, params) {
			const urlsRaw = params.url;
			const urls = Array.isArray(urlsRaw) ? urlsRaw : [urlsRaw];
			const cleaned = urls.map((u) => u.trim()).filter((u) => u.length > 0);
			if (cleaned.length === 0) {
				return err("No valid URL provided");
			}
			const timeoutMs = params.timeoutMs ?? FETCH_TIMEOUT_DEFAULT_MS;

			// Multi-URL parallel (concurrency-limited)
			const limit = pLimit(CONCURRENCY);
			const results = await Promise.all(
				cleaned.map((u) =>
					limit(() =>
						fetchOneUrl(u, timeoutMs).catch(
							(e): FetchedUrl => ({
								url: u,
								title: u,
								content: "",
								error: e instanceof Error ? e.message : String(e),
							}),
						),
					),
				),
			);

			// Store MỌI result (full content) → file, return responseId
			const responseId = randomUUID();
			try {
				await mkdir(FETCH_CACHE_DIR, { recursive: true });
				await writeFile(
					join(FETCH_CACHE_DIR, `${responseId}.json`),
					JSON.stringify(
						{
							id: responseId,
							type: "fetch",
							timestamp: Date.now(),
							urls: results,
						},
						null,
						2,
					),
				);
			} catch (e) {
				// Store fail không fatal — vẫn return content inline, chỉ không retrieve được
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(`[fetch_urls] store cache failed: ${msg}`);
			}

			// Format inline (truncate mỗi content > cap), kèm responseId để retrieve full
			const lines: string[] = [];
			for (const r of results) {
				lines.push(`## ${r.title || r.url}`);
				lines.push(`URL: ${r.url}`);
				if (r.error) {
					lines.push(`Error: ${r.error}`);
				} else {
					const truncated = r.content.length > MAX_INLINE_CHARS;
					const body = truncated
						? r.content.slice(0, MAX_INLINE_CHARS) +
							`\n\n[... truncated ${r.content.length - MAX_INLINE_CHARS} chars of ${r.content.length}]`
						: r.content;
					lines.push("");
					lines.push(body);
				}
				lines.push("");
			}
			const ok2 = results.filter((r) => !r.error).length;
			const summary =
				`Fetched ${results.length} URL(s): ${ok2} ok, ${results.length - ok2} failed. ` +
				`responseId: ${responseId} — call get_search_content("${responseId}") để retrieve full content.`;
			return ok(`${summary}\n\n${lines.join("\n")}`, {
				responseId,
				urlCount: results.length,
				successful: ok2,
			});
		},
	});
}
