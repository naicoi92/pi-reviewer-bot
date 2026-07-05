/**
 * post_summary tool — AI post top-level verdict + summary.
 *
 * Phải được gọi TRƯỚC khi approve_mr. Set state.summaryPosted = true.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { postMrNote } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

export function postSummaryTool(ctx: ToolContext) {
  return defineTool({
    name: "post_summary",
    label: "Post Review Summary",
    description:
      "Post a top-level review summary as a MR comment. MUST be called before approve_mr or request_changes. " +
      "Include your overall assessment, counts of issues by severity, and any patterns you noticed.",
    promptSnippet:
      "post_summary(markdown): post your verdict + summary. Required before approve_mr/request_changes.",
    promptGuidelines: [
      "Always call post_summary before approve_mr or request_changes.",
      "Summary should include: overall verdict, count of issues by severity, key findings.",
    ],
    parameters: Type.Object({
      markdown: Type.String({
        description:
          "Review summary in markdown. Start with a one-line verdict. Include sections for strengths, issues, and any scope-alignment notes.",
      }),
    }),
    async execute(_id, params) {
      const header = "## 🤖 Review (Pi + GLM-5.2)\n\n";
      const footer =
        "\n\n---\n_Automated review by pi-reviewer-bot · Pi SDK + Z.ai GLM-5.2_";
      const body = header + params.markdown + footer;

      const res = await postMrNote(ctx.mrContext, body);
      if ("error" in res) {
        return err(`Failed to post summary: ${res.error}`);
      }
      ctx.state.summaryPosted = true;
      ctx.state.summaryText = params.markdown;
      return ok(`Summary posted (note ${res.id}). You may now call approve_mr (if 0 critical) or request_changes.`, {
        noteId: res.id,
      });
    },
  });
}
