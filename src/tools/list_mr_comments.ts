/**
 * list_mr_comments tool — đọc existing comments trên MR hiện tại.
 *
 * Critical cho idempotent review: khi update MR (push commit), AI biết:
 *   - Comment nào bot đã post (tránh duplicate)
 *   - Critical nào đã post mà chưa resolve (decision giữ/request_changes)
 *   - User đã phản hồi gì
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { listMrComments } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

export function listMrCommentsTool(ctx: ToolContext) {
  return defineTool({
    name: "list_mr_comments",
    label: "List MR Comments",
    description:
      "List existing top-level comments on the current MR (excludes system notes). " +
      "Use BEFORE posting a new review on a re-pushed MR to avoid duplicating feedback already given. " +
      "Identifies which 'critical' comments from a prior review are still unresolved.",
    promptSnippet:
      "list_mr_comments(): existing comments on this MR. Use for idempotent re-review.",
    promptGuidelines: [
      "On MR update events, call list_mr_comments first to see what was already said.",
      "Don't re-post the same critical comment if it's still relevant — instead reference it.",
      "Only post NEW findings or confirm resolved status of prior criticals.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const res = await listMrComments(ctx.mrContext);
      if (!res.ok) {
        return err(`Failed to list comments: ${res.error}`);
      }
      if (res.comments.length === 0) {
        return ok("No prior comments on this MR.", { count: 0 });
      }
      const lines: string[] = [
        `# Prior comments (${res.comments.length} total)`,
        ``,
      ];
      for (const c of res.comments.slice(-30)) {
        const preview = c.body.length > 300 ? c.body.slice(0, 300) + "..." : c.body;
        lines.push(`### @${c.author.username} — ${c.created_at.slice(0, 10)}`);
        lines.push(preview);
        lines.push("");
      }
      return ok(lines.join("\n"), { count: res.comments.length });
    },
  });
}
