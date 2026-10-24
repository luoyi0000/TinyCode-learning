/**
 * Agent Core domain types.
 *
 * HARD RULE: this file (and everything under src/core) must never import the
 * Pi Agent SDK. The Core is runnable with a fake model and fake tools, with no
 * process, network, database or UI. See docs/adapter-mapping.md.
 */

export type ToolName = "list_files" | "read_file" | "write_file" | "run_check";

export interface Task {
  id: string;
  /** Natural-language request from the user. */
  request: string;
  /** Workspace-relative root the agent may touch. */
  workspace: string;
  /** Command that decides whether the change is acceptable. */
  checkCommand: string;
}

export interface ToolIntent {
  name: string;
  arguments: Record<string, unknown>;
}

export type Decision =
  | { kind: "respond"; content: string }
  | { kind: "call_tool"; toolCallId: string; intent: ToolIntent }
  | { kind: "ask_human"; question: string };

/** What the agent learns after an action. Untrusted: truncated by policy. */
export interface Observation {
  toolCallId: string;
  name: string;
  ok: boolean;
  /** Short, human-auditable line. Never the raw payload. */
  summary: string;
  data: unknown;
  observedAt: number;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    }
  | { role: "tool"; toolCallId: string; name: string; text: string; ok: boolean };

export interface CheckOutcome {
  command: string;
  passed: boolean;
  output: string;
}

export interface AgentState {
  task: Task;
  iteration: number;
  messages: ChatMessage[];
  observations: Observation[];
  filesChanged: string[];
  check: CheckOutcome | null;
  /** Material the agent needed but could not get. Drives complete vs partial. */
  missingMaterial: string[];
}

export interface RunResult {
  status: "complete" | "partial";
  content: string;
  missingMaterial: string[];
}

/** Runtime-owned budget. The Core never checks it. */
export interface RunBudget {
  maxIterations: number;
  maxToolCalls: number;
  maxRetries: number;
  timeoutMs: number;
  /**
   * Optional hard cap on the ESTIMATED input size of one model request.
   * Checked by the Runtime after any compaction, never by the Core.
   */
  maxInputTokens?: number;
}

export type RunErrorCode =
  | "budget_iterations"
  | "budget_tools"
  | "budget_timeout"
  | "budget_input_tokens"
  | "no_progress"
  | "rate_limited"
  | "timeout"
  | "auth"
  | "invalid_tool"
  | "provider_unavailable"
  /**
   * The configured model cannot do what this run needs (no tool calling, no images).
   * Distinct from provider_unavailable: a retry can never help, the fix is a
   * different model. Observed for real -- ollama answers 400 "does not support
   * tools" for deepseek-r1. See docs/live-run-notes.md.
   */
  | "model_capability"
  | "runtime_error";

/** Errors the adapters must normalize into. Retryable ones are a Runtime concern. */
export class PortError extends Error {
  readonly code: RunErrorCode;
  readonly retryable: boolean;
  constructor(code: RunErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "PortError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Token/cost metadata. Absent fields stay absent: never invent a number. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

/**
 * Optional live progress. A port may stream tokens while it is still deciding.
 * The Core never passes this -- the Runtime does, so Core semantics are untouched.
 */
export interface ModelProgress {
  onTextDelta?(delta: string): void;
  onThinkingDelta?(delta: string): void;
}

export interface ModelPort {
  /** Human-readable model identity for traces. Optional: a fake has none. */
  readonly label?: string;
  decide(state: AgentState, signal: AbortSignal, progress?: ModelProgress): Promise<Decision>;
  /** Usage of the most recent decide() call, when the provider reported any. */
  getLastUsage?(): ModelUsage | null;
}

export interface ToolPort {
  execute(toolCallId: string, intent: ToolIntent, signal: AbortSignal): Promise<Observation>;
}

export interface StepOutcome {
  decision: Decision;
  state: AgentState;
  /** Non-null when this decision ends the run. */
  terminal: RunResult | null;
}

export interface AgentCore {
  step(state: AgentState, signal: AbortSignal): Promise<StepOutcome>;
}

/** Fresh state for a task. The single entry point Runtime and replay share. */
export function initialState(task: Task): AgentState {
  return {
    task,
    iteration: 0,
    messages: [{ role: "user", text: task.request }],
    observations: [],
    filesChanged: [],
    check: null,
    missingMaterial: [],
  };
}
