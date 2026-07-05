/**
 * request_changes tool — AI request changes (unapprove MR, block merge).
 *
 * Set state.changesRequested = true + state.changesReason = reason.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { unapproveMr } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { err, done } from "./result.ts";

export function requestChangesTool(ctx: ToolContext) {
  return defineTool({
    name: "request_changes",
    label: "Request Changes",
    description:
      "Block the MR from merging by unapproving. Use when there are critical issues that must be fixed before merge. " +
      "Pair with post_inline_comment(severity='critical') for each specific issue.",
    promptSnippet:
      "request_changes(reason): block merge. Use when ≥1 critical issue exists.",
    promptGuidelines: [
      "Call request_changes when you have posted at least one critical inline comment.",
      "Provide a clear reason summarizing what needs to change.",
    ],
    parameters: Type.Object({
      reason: Type.String({
        description:
          "Overall reason for blocking. e.g. '3 critical security issues: SQL injection in user.rs:42, hardcoded secret in config.rs:100, missing LGPL attribution.'",
      }),
    }),
    async execute(_id, params) {
      const res = await unapproveMr(ctx.mrContext);
      if (!res.ok) {
        return err(`GitLab unapprove API failed: ${res.error}`);
      }
      ctx.state.changesRequested = true;
      ctx.state.changesReason = params.reason;
      // terminate=true — review complete
      return done(`Changes requested — MR blocked. Reason: ${params.reason}`, {
        reason: params.reason,
      });
    },
  });
}
