/**
 * fetch_files tool — AI đọc NHIỀU file trong repo clone song song để verify context.
 *
 * Reviewer thường cần xem file ngoài diff để confirm pattern (vd method signature
 * gọi tới, import statement, neighbour code). Tool này scope giới hạn trong
 * repoDir đã clone.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { exists, stat, realpath } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

/** Resolve and verify path stays within repoDir (resists symlink escape). */
async function safeResolve(
	repoDir: string,
	relPath: string,
): Promise<string | null> {
	// Normalize + reject absolute paths and parent traversal
	if (relPath.startsWith("/")) return null;
	const abs = normalize(join(repoDir, relPath));
	// Quick string check first
	if (abs !== repoDir && !abs.startsWith(repoDir + sep)) return null;
	// realpath resolves symlinks — final guard
	try {
		const [realAbs, realRepo] = await Promise.all([
			realpath(abs),
			realpath(repoDir),
		]);
		if (realAbs !== realRepo && !realAbs.startsWith(realRepo + sep))
			return null;
		return realAbs;
	} catch {
		return null; // realpath fails on missing file
	}
}

const MAX_FILE_BYTES = 100_000; // 100KB cap per file read

/** Kết quả đọc 1 file. error=null nghĩa là thành công. */
interface FetchedFile {
	path: string;
	size: number;
	content: string;
	error: string | null;
}

/** Đọc 1 file đã safe-resolve. Trả error trong object (không throw) để batch không bị gián đoạn. */
async function readOne(repoDir: string, relPath: string): Promise<FetchedFile> {
	try {
		const trimmed = relPath.trim();
		if (trimmed.length === 0) {
			return { path: relPath, size: 0, content: "", error: "Empty path" };
		}
		const abs = await safeResolve(repoDir, trimmed);
		if (!abs) {
			return {
				path: trimmed,
				size: 0,
				content: "",
				error: "Path traversal blocked or not found",
			};
		}
		if (!(await exists(abs))) {
			return { path: trimmed, size: 0, content: "", error: "File not found" };
		}
		const s = await stat(abs);
		if (!s.isFile()) {
			return {
				path: trimmed,
				size: 0,
				content: "",
				error: "Not a regular file",
			};
		}
		if (s.size > MAX_FILE_BYTES) {
			return {
				path: trimmed,
				size: s.size,
				content: "",
				error: `File too large (${s.size} bytes > ${MAX_FILE_BYTES})`,
			};
		}
		const content = await Bun.file(abs).text();
		return { path: trimmed, size: s.size, content, error: null };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			path: relPath,
			size: 0,
			content: "",
			error: `Read failed: ${msg}`,
		};
	}
}

export function fetchFileTool(ctx: ToolContext) {
	return defineTool({
		name: "fetch_files",
		label: "Fetch Files",
		description:
			"Đọc NHIỀU file song song từ repo clone để verify context (imports, method signatures, neighbour code). " +
			'TRUYỀN ARRAY paths=["...","..."] để đọc nhiều file cùng lúc — KHÔNG call từng file riêng. ' +
			"Use when the diff alone is not enough to judge correctness.",
		promptSnippet:
			"fetch_files(paths: string[]): đọc NHIỀU file song song trong 1 call (truyền array). LUÔN truyền array, kể cả 1 file: ['path']. Dùng verify imports/signature/neighbour code ngoài diff.",
		parameters: Type.Object({
			path: Type.Array(Type.String(), {
				description:
					"Danh sách path relative to repo root — đọc song song. LUÔN truyền array, kể cả 1 file. e.g. ['src/lib/auth.ts', 'src/utils/token.rs']",
				minItems: 1,
			}),
		}),
		async execute(_id, params) {
			const pathsRaw = params.path;
			const paths = Array.isArray(pathsRaw) ? pathsRaw : [pathsRaw];
			const cleaned = [
				...new Set(paths.map((p) => p.trim()).filter((p) => p.length > 0)),
			];
			if (cleaned.length === 0) {
				return err("No valid path provided");
			}

			// Multi-file parallel (security guard áp dụng mỗi path)
			const results = await Promise.all(
				cleaned.map((p) => readOne(ctx.repoDir, p)),
			);

			// Format output — mỗi file có header riêng để AI phân biệt
			const lines: string[] = [];
			for (const r of results) {
				lines.push(`## ${r.path}`);
				if (r.error) {
					lines.push(`Error: ${r.error}`);
				} else {
					lines.push(`(${r.size} bytes)`);
					lines.push("");
					lines.push(r.content);
				}
				lines.push("");
			}
			const okCount = results.filter((r) => !r.error).length;
			const summary = `Fetched ${results.length} file(s): ${okCount} ok, ${results.length - okCount} failed.`;
			return ok(`${summary}\n\n${lines.join("\n")}`, {
				pathCount: results.length,
				successful: okCount,
			});
		},
	});
}
