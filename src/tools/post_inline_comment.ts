/**
 * post_inline_comment tool — AI post line-specific DiffNote.
 *
 * Sử dụng GitLab Discussions API với position hash (Notes API không support inline).
 * Severity "critical" increments state.criticalCount — block approve_mr khi > 0.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { postDiffNote } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🚫",
  suggestion: "💡",
  nit: "🎨",
  praise: "✅",
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  suggestion: "Suggestion",
  nit: "Nit",
  praise: "Praise",
};

/**
 * Extract valid line ranges (in NEW file version) from a unified diff.
 * Returns Set of line numbers that exist in `+` lines or @@ hunk headers.
 *
 * Format: `@@ -oldStart,oldLen +newStart,newLen @@`
 * New-side range is [newStart, newStart + newLen - 1].
 */
function extractValidNewLines(diff: string): Set<number> {
  const valid = new Set<number>();
  const hunkRe = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
  let m: RegExpExecArray | null;
  while ((m = hunkRe.exec(diff)) !== null) {
    const start = parseInt(m[1]!, 10);
    const len = m[2] ? parseInt(m[2], 10) : 1;
    for (let i = start; i < start + len; i++) valid.add(i);
  }
  // Also accept any `+` content line number explicitly (paranoid)
  return valid;
}

export function postInlineCommentTool(ctx: ToolContext) {
  return defineTool({
    name: "post_inline_comment",
    label: "Post Inline Comment",
    description:
      "Post a line-specific comment on a file in the MR diff. Use severity to indicate urgency — " +
      "'critical' blocks approve_mr; 'suggestion'/'nit' do not.",
    promptSnippet:
      "post_inline_comment(path, line, comment, severity): line-specific DiffNote. severity=critical blocks approve.",
    promptGuidelines: [
      "Use severity='critical' only for issues that must be fixed before merge (security, crash, license violation, data loss).",
      "Use 'suggestion' for improvements, 'nit' for style, 'praise' to reinforce good patterns.",
      "Verify the line number exists in the diff before posting.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "File path — must match new_path of a diff entry",
      }),
      line: Type.Number({
        description: "Line number in the NEW version of the file (1-indexed)",
      }),
      comment: Type.String({
        description: "Comment markdown",
      }),
      severity: Type.Union(
        [
          Type.Literal("critical"),
          Type.Literal("suggestion"),
          Type.Literal("nit"),
          Type.Literal("praise"),
        ],
        { description: "Comment severity — 'critical' blocks approve_mr" },
      ),
    }),
    async execute(_id, params) {
      const diffEntry = ctx.diffEntries.find((d) => d.new_path === params.path);
      if (!diffEntry) {
        return err(
          `Path '${params.path}' not in diff. Available: ${ctx.diffEntries.slice(0, 5).map((d) => d.new_path).join(", ")}${ctx.diffEntries.length > 5 ? "..." : ""}`,
        );
      }

      // Validate line exists in the new-side hunk range of the diff
      const validLines = extractValidNewLines(diffEntry.diff);
      if (validLines.size > 0 && !validLines.has(params.line)) {
        const ranges = Array.from(validLines).sort((a, b) => a - b);
        const min = ranges[0]!;
        const max = ranges[ranges.length - 1]!;
        return err(
          `Line ${params.line} not in diff range for ${params.path}. Valid new-side lines: ${min}-${max} (${validLines.size} lines). Re-check the diff hunk headers.`,
        );
      }

      const emoji = SEVERITY_EMOJI[params.severity] ?? "💬";
      const label = SEVERITY_LABEL[params.severity] ?? params.severity;
      const body = `${emoji} **${label}:** ${params.comment}`;

      const res = await postDiffNote(ctx.mrContext, {
        newPath: params.path,
        oldPath: diffEntry.old_path,
        newLine: params.line,
        body,
      });

      if ("error" in res) {
        return err(`Failed to post inline comment: ${res.error}`);
      }

      if (params.severity === "critical") {
        ctx.state.criticalCount += 1;
      }
      ctx.state.inlineCommentsPosted += 1;

      const msg =
        params.severity === "critical"
          ? `Critical comment posted at ${params.path}:${params.line}. approve_mr is now BLOCKED (${ctx.state.criticalCount} critical unresolved).`
          : `${label} comment posted at ${params.path}:${params.line}.`;
      return ok(msg, { discussionId: res.id, severity: params.severity });
    },
  });
}
