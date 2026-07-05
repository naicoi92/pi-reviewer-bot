/**
 * Per-MR shallow repo clone.
 *
 * Why clone at all (instead of just feeding the diff to Pi)?
 *   - The agent needs `AGENTS.md`, `.pi/agents/code-reviewer.md`, and
 *     `.pi/config.yaml` to know per-project review rules.
 *   - For Scope Alignment Check, it reads `docs/design/07-roadmap.md` and
 *     similar files referenced by the project config.
 *
 * Strategy: `git clone --depth 1` of the source branch. Fast (<5s for most
 * repos) and sufficient for reading config + recent files.
 */

import { exists, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { authenticatedCloneUrl, redactToken } from "./gitlab.ts";
import type { MergeRequestWebhook } from "./types.ts";

const TMP_ROOT = process.env.REPO_TMP_ROOT ?? "/tmp/pi-reviews";

export interface ClonedRepo {
  /** Absolute path to the cloned working tree. */
  dir: string;
  /** True if `.pi/` exists in the repo (project has custom config). */
  hasPiConfig: boolean;
  /** Cleanup function — caller MUST call this when done. */
  cleanup: () => Promise<void>;
}

function shortSha(s: string | undefined): string {
  return s ? s.slice(0, 8) : "nocommit";
}

/**
 * Shallow-clone the source branch of the MR.
 *
 * @returns ClonedRepo or throws on git error.
 */
export async function cloneForReview(
  payload: MergeRequestWebhook,
): Promise<ClonedRepo> {
  const mr = payload.object_attributes;
  const project = payload.project;
  const dir = join(TMP_ROOT, `${project.id}`, `mr-${mr.iid}-${shortSha(mr.source_branch_sha)}`);

  // Idempotent: remove any stale clone from a previous attempt
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const cloneUrl = authenticatedCloneUrl(project);
  const args = [
    "clone",
    "--depth",
    "1",
    "--branch",
    mr.source_branch,
    "--single-branch",
    cloneUrl,
    dir,
  ];

  console.log(`[repo] cloning ${project.path_with_namespace} @ ${mr.source_branch} → ${dir}`);
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Prevent git from prompting for credentials interactively
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/echo",
    },
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    // Redact any leaked token from git error messages
    throw new Error(`git clone failed (exit ${exitCode}): ${redactToken(stderr.trim())}`);
  }

  const piConfigDir = join(dir, ".pi");
  const hasPiConfig = await exists(piConfigDir);

  return {
    dir,
    hasPiConfig,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Read a UTF-8 file from the cloned repo, returning null if missing.
 * Used by config loader + scope-check helpers.
 */
export async function readFileOrNull(dir: string, relPath: string): Promise<string | null> {
  const abs = join(dir, relPath);
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
}
