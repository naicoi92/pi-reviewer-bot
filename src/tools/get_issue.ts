/**
 * get_issue tool — đọc GitLab issue gốc + comments + linked MRs.
 *
 * Critical cho Scope Alignment Check: AI verify "Resolves: #XX" thực sự
 * khớp task nào, đọc comments để biết clarifications, thấy linked MRs khác.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { getIssue } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

export function getIssueTool(ctx: ToolContext) {
  return defineTool({
    name: "get_issue",
    label: "Get GitLab Issue",
    description:
      "Read a GitLab issue by its IID (the number shown in UI, not global ID) — including description, " +
      "labels, milestone, comments, and linked MRs. Use for Scope Alignment Check: verify the MR's " +
      "'Resolves: #N' actually matches the claimed task.",
    promptSnippet:
      "get_issue(iid): read GitLab issue (title, description, comments, labels, linked MRs). For scope alignment verification.",
    parameters: Type.Object({
      iid: Type.Number({
        description: "Issue IID — the number in 'Resolves: #N'. Not the global ID.",
      }),
    }),
    async execute(_id, params) {
      const res = await getIssue(ctx.mrContext.projectId, params.iid);
      if (!res.ok) {
        return err(`Failed to fetch issue #${params.iid}: ${res.error}`);
      }
      const i = res.issue;
      const lines: string[] = [
        `# Issue #${i.iid}: ${i.title}`,
        `State: ${i.state} | Milestone: ${i.milestone?.title ?? "(none)"} | Labels: ${i.labels.join(", ") || "(none)"}`,
        `Assignees: ${i.assignees.map((a) => a.username).join(", ") || "(none)"}`,
        `URL: ${i.web_url}`,
        ``,
        `## Description`,
        i.description ?? "(no description)",
      ];
      if (i.related_merge_requests && i.related_merge_requests.length > 0) {
        lines.push("", "## Linked MRs");
        for (const mr of i.related_merge_requests) {
          lines.push(`- !${mr.iid} [${mr.state}] ${mr.title}`);
        }
      }
      if (i.notes && i.notes.length > 0) {
        lines.push("", "## Comments (non-system)");
        for (const n of i.notes.slice(0, 20)) {
          lines.push(`- **@${n.author.username}** (${n.created_at.slice(0, 10)}): ${n.body}`);
        }
        if (i.notes.length > 20) lines.push(`- _... and ${i.notes.length - 20} more comments_`);
      }
      return ok(lines.join("\n"), { issueIid: i.iid });
    },
  });
}
