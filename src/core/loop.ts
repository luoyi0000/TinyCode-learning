import { isAllowedTool, stringArg, truncate } from "./policy.ts";
import {
  PortError,
  type AgentCore,
  type AgentState,
  type CheckOutcome,
  type Decision,
  type ModelPort,
  type Observation,
  type RunResult,
  type StepOutcome,
  type ToolPort,
} from "./types.ts";

/**
 * The Core owns the meaning of one step:
 *   model decision -> optional tool action -> observation -> state update
 *
 * It knows nothing about sessions, events, budgets, persistence or signal
 * composition -- those are Runtime concerns. It only honours the signal it is given,
 * and it never mutates the state handed to it.
 */

/**
 * The one rule that decides complete vs partial.
 *
 * Evidence is required: a run that recorded no observation proved nothing, even if
 * nothing "failed". Found by a real live run -- a text-only agent answered a question
 * about a file it never read and claimed success. The skill demands that a result
 * "never claims unsupported success", so no evidence means no complete.
 */
export function finalVerdict(state: AgentState): {
  status: "complete" | "partial";
  missingMaterial: string[];
} {
  const missing = [...state.missingMaterial];

  // No action, no evidence: an answer proves nothing about the repository.
  if (state.observations.length === 0 && !missing.includes(EVIDENCE_GAP)) {
    missing.push(EVIDENCE_GAP);
  }

  // Changed something but never proved it is good. A successful write only proves
  // the I/O worked. Found by a live run: qwen2.5:7b wrote "hello tinycode." (extra
  // period), never ran the check, and the old rule still said complete.
  const checkFailed = state.check !== null && !state.check.passed;
  if (state.filesChanged.length > 0 && !checkFailed && state.check?.passed !== true) {
    if (!missing.includes(UNVERIFIED_CHANGE)) missing.push(UNVERIFIED_CHANGE);
  }

  return { status: missing.length === 0 ? "complete" : "partial", missingMaterial: missing };
}

export const EVIDENCE_GAP = "evidence:no observation recorded";
export const UNVERIFIED_CHANGE = "check:required_after_change";

function addMissing(list: string[], entry: string): string[] {
  return list.includes(entry) ? list : [...list, entry];
}

/**
 * The single transition that turns (state, decision, observation) into the next state.
 * The live loop and event-log replay both call it, so a recovered state cannot drift
 * from a live one by construction.
 */
export function applyToolStep(
  state: AgentState,
  decision: Extract<Decision, { kind: "call_tool" }>,
  observation: Observation,
): AgentState {
  const intent = decision.intent;
  let missing = [...state.missingMaterial];
  if (!observation.ok && !isAllowedTool(intent.name)) {
    missing = addMissing(missing, "tool:" + intent.name);
  } else if (!observation.ok) {
    missing = addMissing(missing, "tool_error:" + intent.name);
  }

  let check = state.check;
  if (intent.name === "run_check" && observation.ok) {
    check = observation.data as CheckOutcome;
    // A passing check retracts an earlier failure: the run can be complete again.
    missing = check.passed
      ? missing.filter((m) => !m.startsWith("check_failed:"))
      : addMissing(missing, "check_failed:" + check.command);
  }

  const filesChanged = [...state.filesChanged];
  if (intent.name === "write_file" && observation.ok) {
    const path = stringArg(intent, "path");
    if (path && !filesChanged.includes(path)) filesChanged.push(path);
    // A check that ran before this write says nothing about the file we just changed.
    check = null;
  }

  return {
    task: state.task,
    iteration: state.iteration + 1,
    messages: [
      ...state.messages,
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: decision.toolCallId, name: intent.name, arguments: intent.arguments }],
      },
      { role: "tool", toolCallId: decision.toolCallId, name: intent.name, text: truncate(observation.summary), ok: observation.ok },
    ],
    observations: [...state.observations, observation],
    filesChanged,
    check,
    missingMaterial: missing,
  };
}

export function createCore(model: ModelPort, tools: ToolPort): AgentCore {
  return {
    async step(state: AgentState, signal: AbortSignal): Promise<StepOutcome> {
      signal.throwIfAborted();
      const decision: Decision = await model.decide(state, signal);

      if (decision.kind === "respond") {
        const verdict = finalVerdict(state);
        const result: RunResult = {
          status: verdict.status,
          content: decision.content,
          missingMaterial: verdict.missingMaterial,
        };
        return { decision, state, terminal: result };
      }

      if (decision.kind === "ask_human") {
        return { decision, state: { ...state, iteration: state.iteration + 1 }, terminal: null };
      }

      const { toolCallId, intent } = decision;
      let observation: Observation;

      try {
        observation = await tools.execute(toolCallId, intent, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const code = error instanceof PortError ? error.code : "runtime_error";
        const message = error instanceof Error ? error.message : String(error);
        // A failed tool is visible, and it never corrupts unrelated state.
        observation = {
          toolCallId,
          name: intent.name,
          ok: false,
          summary: truncate(code + ": " + message, 300),
          data: null,
          observedAt: Date.now(),
        };
      }

      return { decision, state: applyToolStep(state, decision, observation), terminal: null };
    },
  };
}
