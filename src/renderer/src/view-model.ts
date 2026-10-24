import type { RunEventMessage } from "../../shared/ipc.ts";

/**
 * View model for the renderer.
 *
 * All event handling is one pure reducer, not a pile of effects: every reducer case
 * maps one product event to one visible change, which keeps React out of the
 * protocol's way (and would let this be unit-tested without a DOM).
 */

export type Phase = "idle" | "running" | "finished";

export interface TraceLine {
  sequence: number;
  kind: "detail";
  text: string;
  tone: "neutral" | "good" | "bad" | "warn";
}

export interface UiState {
  phase: Phase;
  /** Typewriter body: only primary-level text lands here. */
  body: string;
  trace: TraceLine[];
  toolCalls: number;
  tokens: { input?: number; output?: number };
  verdict: { status: string; message: string; missing: string[] } | null;
  error: string | null;
}

export const initialUiState: UiState = {
  phase: "idle",
  body: "",
  trace: [],
  toolCalls: 0,
  tokens: {},
  verdict: null,
  error: null,
};

function line(sequence: number, text: string, tone: TraceLine["tone"] = "neutral"): TraceLine {
  return { sequence, kind: "detail", text, tone };
}

export function reduce(state: UiState, event: RunEventMessage): UiState {
  switch (event.type) {
    case "run_started":
      return { ...initialUiState, phase: "running" };

    case "text_delta":
      // primary channel: the answer as it is written
      return { ...state, body: state.body + event.delta };

    case "thinking_delta":
      return state;

    case "model_requested":
      return { ...state, trace: [...state.trace, line(event.sequence, "thinking…")] };

    case "decision_made":
      return {
        ...state,
        trace: [
          ...state.trace,
          line(event.sequence, "decision: " + event.decision.kind, event.decision.kind === "respond" ? "good" : "neutral"),
        ],
      };

    case "tool_started":
      return { ...state, trace: [...state.trace, line(event.sequence, "▸ " + event.toolName)] };

    case "tool_completed":
      return {
        ...state,
        toolCalls: state.toolCalls + 1,
        trace: [
          ...state.trace,
          line(
            event.sequence,
            "✔ " + event.toolName + " (" + event.durationMs + "ms)",
            event.status === "success" ? "good" : "bad",
          ),
        ],
      };

    case "observation_added":
      return {
        ...state,
        trace: [
          ...state.trace,
          line(event.sequence, (event.observation.ok ? "  " : "  ✖ ") + event.observation.summary.slice(0, 160), event.observation.ok ? "neutral" : "bad"),
        ],
      };

    case "compact_boundary":
      return {
        ...state,
        trace: [
          ...state.trace,
          line(event.sequence, "context compacted: dropped " + event.elided + " msg(s) → " + event.estimatedTokens + " est. tokens", "warn"),
        ],
      };

    case "usage_reported":
      return {
        ...state,
        toolCalls: event.usage.toolCalls,
        tokens: { input: event.usage.inputTokens, output: event.usage.outputTokens },
      };

    case "run_completed":
      return {
        ...state,
        phase: "finished",
        verdict: {
          status: event.status,
          message: typeof event.result === "string" ? event.result : "",
          missing: event.missingMaterial ?? [],
        },
      };

    case "run_failed":
      return {
        ...state,
        phase: "finished",
        verdict: { status: "failed", message: event.error.code + ": " + event.error.message, missing: [] },
      };

    case "run_cancelled":
      return { ...state, phase: "finished", verdict: { status: "cancelled", message: "cancelled by user", missing: [] } };

    default:
      return state;
  }
}
