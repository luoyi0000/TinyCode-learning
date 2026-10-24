import type { AgentEvent } from "./events.ts";

/**
 * Product events -> front-end stream events.
 *
 * `displayLevel` is the whole point: the UI decides primary (typewriter body) vs
 * detail (collapsible thinking / tool trace) from this field alone, so the CLI and a
 * future web client share ONE protocol instead of inventing two.
 *
 * Raw SDK callbacks never reach here -- only AgentEvent does.
 */

export type DisplayLevel = "primary" | "detail" | "terminal";

export interface StreamEvent {
  type: string;
  displayLevel: DisplayLevel;
  sequence: number;
  timestamp: number;
  payload: Record<string, unknown>;
}

export function toStreamEvent(event: AgentEvent): StreamEvent {
  const base = { sequence: event.sequence, timestamp: event.timestamp };
  switch (event.type) {
    case "text_delta":
      return { ...base, type: "text_delta", displayLevel: "primary", payload: { delta: event.delta } };
    case "thinking_delta":
      return { ...base, type: "thinking_delta", displayLevel: "detail", payload: { delta: event.delta } };
    case "tool_started":
      return { ...base, type: "tool_use_start", displayLevel: "detail", payload: { toolCallId: event.toolCallId, toolName: event.toolName } };
    case "tool_completed":
      return {
        ...base,
        type: "tool_use_end",
        displayLevel: "detail",
        payload: { toolCallId: event.toolCallId, toolName: event.toolName, status: event.status, durationMs: event.durationMs, error: event.error },
      };
    case "usage_reported":
      return { ...base, type: "usage", displayLevel: "detail", payload: { ...event.usage } };
    case "compact_boundary":
      return {
        ...base,
        type: "compact_boundary",
        displayLevel: "detail",
        payload: { elided: event.elided, estimatedTokens: event.estimatedTokens },
      };
    case "run_completed":
      return { ...base, type: "end", displayLevel: "terminal", payload: { status: event.status, result: event.result, missingMaterial: event.missingMaterial } };
    case "run_failed":
      return { ...base, type: "end", displayLevel: "terminal", payload: { status: "failed", error: event.error } };
    case "run_cancelled":
      return { ...base, type: "end", displayLevel: "terminal", payload: { status: "cancelled" } };
    case "decision_made":
      return { ...base, type: "decision", displayLevel: "detail", payload: { kind: event.decision.kind } };
    case "observation_added":
      return {
        ...base,
        type: "observation",
        displayLevel: "detail",
        payload: { name: event.name, ok: event.observation.ok, summary: event.observation.summary },
      };
    default:
      return { ...base, type: event.type, displayLevel: "detail", payload: {} };
  }
}

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};

/** One SSE frame. Single-consumer by design: reconnect through the run log instead. */
export function sseFrame(event: AgentEvent): string {
  return "data: " + JSON.stringify(toStreamEvent(event)) + "\n\n";
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled";
}
