/**
 * get_search_content — retrieve full content của fetch_urls result trước đó.
 *
 * fetch_urls store MỌI result → `$PI_AGENT_DIR/fetch-cache/<responseId>.json`.
 * Tool này đọc lại theo responseId (trả về fetch_urls ở turn trước).
 *
 * Dùng khi content inline bị truncate (>100KB) hoặc AI cần reference lại
 * nội dung đã fetch mà không re-fetch (tiết kiệm web call budget).
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

/** Cache dir — phải khớp fetch_urls.ts. */
const FETCH_CACHE_DIR = join(
	process.env.PI_AGENT_DIR ?? "/tmp/pi-agent",
	"fetch-cache",
);

interface CachedUrl {
	url: string;
	title: string;
	content: string;
	error: string | null;
}
interface CachedFetch {
	id: string;
	type: "fetch";
	timestamp: number;
	urls: CachedUrl[];
}

export function getSearchContentTool(_ctx: ToolContext) {
	return defineTool({
		name: "get_search_content",
		label: "Get Search Content",
		description:
			"Retrieve full content của fetch_urls result trước đó (theo responseId). " +
			"Dùng khi content inline bị truncate (>100KB) hoặc cần reference lại " +
			"nội dung đã fetch. Tránh re-fetch (tiết kiệm web call budget).",
		promptSnippet:
			"get_search_content(responseId, urlIndex?): retrieve full content từ fetch_urls trước đó.",
		parameters: Type.Object({
			responseId: Type.String({
				description: "responseId trả về từ fetch_urls call trước đó.",
			}),
			urlIndex: Type.Optional(
				Type.Number({
					description:
						"Index của URL cụ thể trong batch (0-based). Omit → return tất cả URL trong batch.",
					minimum: 0,
				}),
			),
		}),
		async execute(_id, params) {
			const file = join(FETCH_CACHE_DIR, `${params.responseId}.json`);
			if (!existsSync(file)) {
				return err(
					`responseId "${params.responseId}" not found. ` +
						"Phải là responseId hợp lệ từ fetch_urls call trước đó trong cùng review.",
				);
			}
			let cached: CachedFetch;
			try {
				const raw = await readFile(file, "utf-8");
				cached = JSON.parse(raw) as CachedFetch;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return err(`Failed to read cached content: ${msg}`);
			}
			// urlIndex cụ thể → return 1 URL; omit → return tất cả
			if (params.urlIndex !== undefined) {
				const item = cached.urls[params.urlIndex];
				if (!item) {
					return err(
						`urlIndex ${params.urlIndex} out of range (batch có ${cached.urls.length} URL(s), index 0..${cached.urls.length - 1}).`,
					);
				}
				const titleLine =
					item.title && item.title !== item.url ? `# ${item.title}\n\n` : "";
				return ok(
					`${titleLine}URL: ${item.url}\n\n${item.error ? `Error: ${item.error}` : item.content}`,
					{ responseId: params.responseId, urlCount: 1 },
				);
			}
			// Return tất cả URL trong batch
			const lines: string[] = [
				`# Batch ${params.responseId} (${cached.urls.length} URL)`,
			];
			for (let i = 0; i < cached.urls.length; i++) {
				const u = cached.urls[i]!;
				lines.push("");
				lines.push(`## [${i}] ${u.title || u.url}`);
				lines.push(`URL: ${u.url}`);
				lines.push(u.error ? `Error: ${u.error}` : u.content);
			}
			return ok(lines.join("\n"), {
				responseId: params.responseId,
				urlCount: cached.urls.length,
			});
		},
	});
}
