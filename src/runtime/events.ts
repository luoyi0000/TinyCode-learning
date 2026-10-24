import type { Decision, Observation, RunErrorCode } from "../core/types.ts";

/**
 * Product-level events. Raw SDK callbacks never become this contract; the CLI, the
 * trace writer, the run log and the tests all consume only these.
 */

export interface EventBase {
  runId: string;
  /** Monotonic per run. Assigned at publish time so emission order == sequence order. */
  sequence: number;
  timestamp: number;
}

export type AgentEventBody =
  | { type: "run_started" }
  | { type: "model_requested"; model?: string }
  | { type: "decision_made"; decision: Decision }
  /**
   * Token deltas. TRANSIENT: live-only, never persisted to the run log.
   * State reconstruction never needs them, and persisting every token would turn
   * an auditable event log into a transcript dump.
   */
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_started"; toolCallId: string; toolName: string }
  | {
      type: "tool_completed";
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
      result?: unknown;
      error?: { code: string; message: string };
      durationMs: number;
    }
  | { type: "observation_added"; name: string; observation: Observation }
  /**
   * Context was elided to stay inside budget. Persisted on purpose: replay must
   * reproduce the compacted transcript, otherwise a recovered state would differ
   * from the live one it claims to rebuild.
   */
  | { type: "compact_boundary"; elided: number; keepRecentMessages: number; estimatedTokens: number }
  | { type: "human_input_requested"; question: string }
  | { type: "human_input_received"; input: unknown }
  | { type: "run_resumed" }
  | {
      type: "usage_reported";
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        toolCalls: number;
        durationMs: number;
        model?: string;
      };
    }
  | {
      type: "run_completed";
      status: "complete" | "partial";
      result: unknown;
      missingMaterial?: string[];
    }
  | { type: "run_failed"; error: { code: RunErrorCode; message: string } }
  | { type: "run_cancelled" };

export type AgentEvent = AgentEventBody & EventBase;

/** A body plus the moment it actually happened, still waiting for its sequence number. */
export interface StagedEvent {
  body: AgentEventBody;
  timestamp: number;
}

export function stage(body: AgentEventBody, timestamp = Date.now()): StagedEvent {
  return { body, timestamp };
}

export interface EventPublisher {
  (staged: StagedEvent): AgentEvent;
  readonly published: number;
}

export function createPublisher(runId: string): EventPublisher {
  let sequence = 0;
  const publisher = ((staged: StagedEvent): AgentEvent => {
    sequence += 1;
    return { ...staged.body, runId, sequence, timestamp: staged.timestamp };
  }) as EventPublisher;
  Object.defineProperty(publisher, "published", {
    get: () => sequence,
  });
  return publisher;
}

export const TERMINAL: ReadonlySet<AgentEventBody["type"]> = new Set<AgentEventBody["type"]>([
  "run_completed",
  "run_failed",
  "run_cancelled",
]);

export function isTerminal(event: AgentEvent): boolean {
  return TERMINAL.has(event.type);
}
