/**
 * Helper để build AgentToolResult đúng shape.
 *
 * AgentToolResult cần:
 *   - content: TextContent[] — text trả về cho LLM
 *   - details: T — arbitrary data cho logs/UI
 *   - terminate?: boolean — hint agent dừng sau tool batch
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Success result. */
export function ok<TDetails>(message: string, details?: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text: message }],
    details: (details ?? ({} as TDetails)) as TDetails,
  };
}

/** Error result. Still 200 from agent's POV — error encoded in content text. */
export function err(message: string): AgentToolResult<never> {
  return {
    content: [{ type: "text", text: `ERROR: ${message}` }],
    details: {} as never,
  };
}

/** Success + terminate hint (e.g. after approve_mr, agent should wrap up). */
export function done<TDetails>(message: string, details?: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text: message }],
    details: (details ?? ({} as TDetails)) as TDetails,
    terminate: true,
  };
}
