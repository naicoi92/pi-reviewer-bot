/**
 * list_mr_commits tool — đọc commit history của MR.
 *
 * Help AI hiểu iteration:
 *   - "commit 2 fix issue từ commit 1" → don't flag it again
 *   - Force-push pattern (commits bị rewrite)
 *   - Conventional commit messages cho changelog
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { listMrCommits } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

export function listMrCommitsTool(ctx: ToolContext) {
  return defineTool({
    name: "list_mr_commits",
    label: "List MR Commits",
    description:
      "List commits in the MR (oldest first). Use to understand iteration history: trace fix-up commits, " +
      "see conventional commit messages, detect force-push rewrites. Helpful when reviewing an updated MR " +
      "to focus only on what changed in the latest push.",
    promptSnippet:
      "list_mr_commits(): commit history of this MR. For iteration context.",
    parameters: Type.Object({}),
    async execute() {
      const res = await listMrCommits(ctx.mrContext);
      if (!res.ok) {
        return err(`Failed to list commits: ${res.error}`);
      }
      if (res.commits.length === 0) {
        return ok("No commits in this MR.", { count: 0 });
      }
      const lines: string[] = [`# Commits in MR (${res.commits.length} total)`, ``];
      for (const c of res.commits) {
        lines.push(`- \`${c.short_id}\` **${c.title}** — @${c.author_name} (${c.authored_date.slice(0, 10)})`);
      }
      return ok(lines.join("\n"), { count: res.commits.length });
    },
  });
}
