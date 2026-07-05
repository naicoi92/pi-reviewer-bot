/**
 * approve_mr tool — AI approve MR qua GitLab API.
 *
 * Guardrail (anti-hallucination):
 *   1. Phải gọi post_summary trước (state.summaryPosted)
 *   2. Không có critical comment unresolved (state.criticalCount === 0)
 *
 * Khi pass guardrail, call approveMr() và set state.approved = true.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { approveMr } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { err, done } from "./result.ts";

export function approveMrTool(ctx: ToolContext) {
  return defineTool({
    name: "approve_mr",
    label: "Approve Merge Request",
    description:
      "Approve the MR in GitLab (unblocks merge if approval rule requires bot). " +
      "ONLY call after post_summary AND when no critical issues remain.",
    promptSnippet:
      "approve_mr(confidence, rationale): approve MR. Blocked if summary not posted or critical issues unresolved.",
    promptGuidelines: [
      "Call approve_mr ONLY when: (a) you have already called post_summary, AND (b) you have ZERO unresolved critical inline comments.",
      "If any critical issue exists, call request_changes instead.",
      "Provide a one-line rationale explaining your confidence.",
    ],
    parameters: Type.Object({
      rationale: Type.String({
        description:
          "One-line rationale for approval. e.g. 'Code follows conventions, no security issues, scope is correct.'",
      }),
    }),
    async execute(_id, params) {
      if (!ctx.state.summaryPosted) {
        return err(
          "BLOCKED: Call post_summary() with your verdict and rationale before approve_mr(). The team needs a written review.",
        );
      }
      if (ctx.state.criticalCount > 0) {
        return err(
          `BLOCKED: ${ctx.state.criticalCount} critical inline comment(s) unresolved. Either resolve them (they were actually suggestions) or call request_changes(reason).`,
        );
      }
      const res = await approveMr(ctx.mrContext, ctx.mrContext.sourceSha);
      if (!res.ok) {
        return err(`GitLab approve API failed: ${res.error}`);
      }
      ctx.state.approved = true;
      // terminate=true — review complete, agent should stop calling tools
      return done(`MR approved in GitLab. Rationale: ${params.rationale}`, {
        rationale: params.rationale,
      });
    },
  });
}
