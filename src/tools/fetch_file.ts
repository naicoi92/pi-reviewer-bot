/**
 * fetch_file tool — AI đọc file trong repo clone để verify context.
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
async function safeResolve(repoDir: string, relPath: string): Promise<string | null> {
  // Normalize + reject absolute paths and parent traversal
  if (relPath.startsWith("/")) return null;
  const abs = normalize(join(repoDir, relPath));
  // Quick string check first
  if (abs !== repoDir && !abs.startsWith(repoDir + sep)) return null;
  // realpath resolves symlinks — final guard
  try {
    const [realAbs, realRepo] = await Promise.all([realpath(abs), realpath(repoDir)]);
    if (realAbs !== realRepo && !realAbs.startsWith(realRepo + sep)) return null;
    return realAbs;
  } catch {
    return null; // realpath fails on missing file
  }
}

const MAX_FILE_BYTES = 100_000; // 100KB cap per file read

export function fetchFileTool(ctx: ToolContext) {
  return defineTool({
    name: "fetch_file",
    label: "Fetch File",
    description:
      "Read a file from the cloned repo to verify context (imports, method signatures, neighbour code). " +
      "Use when the diff alone is not enough to judge correctness.",
    promptSnippet:
      "fetch_file(path): read a file from the repo for additional context.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path relative to repo root. e.g. 'src/lib/auth.ts'",
      }),
    }),
    async execute(_id, params) {
      try {
        const abs = await safeResolve(ctx.repoDir, params.path);
        if (!abs) {
          return err(`Path traversal blocked or not found: ${params.path}`);
        }
        if (!(await exists(abs))) {
          return err(`File not found: ${params.path}`);
        }
        const s = await stat(abs);
        if (!s.isFile()) {
          return err(`Not a regular file: ${params.path}`);
        }
        if (s.size > MAX_FILE_BYTES) {
          return err(`File too large (${s.size} bytes > ${MAX_FILE_BYTES}). Use a narrower scope.`);
        }
        const content = await Bun.file(abs).text();
        return ok(`Fetched ${params.path} (${s.size} bytes)\n\n${content}`, {
          path: params.path,
          size: s.size,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`Read failed: ${msg}`);
      }
    },
  });
}
