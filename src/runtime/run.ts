import { randomUUID } from "node:crypto";

import { compactContext, estimateTokens } from "../core/context.ts";
import { createCore } from "../core/loop.ts";
import { isAllowedTool } from "../core/policy.ts";
import {
  PortError,
  initialState,
  type AgentState,
  type ModelPort,
  type Observation,
  type RunBudget,
  type RunErrorCode,
  type StepOutcome,
  type Task,
  type ToolPort,
} from "../core/types.ts";
import { DEFAULT_BUDGET, composeSignal } from "./budget.ts";
import { createDeltaQueue, type DeltaQueue } from "./delta-queue.ts";
import { createPublisher, stage, type AgentEvent, type StagedEvent } from "./events.ts";
import type { Run, RunLog } from "./runlog.ts";

export interface RuntimeConfig {
  model: ModelPort;
  tools: ToolPort;
  runLog?: RunLog;
  budget?: Partial<RunBudget>;
  /** Injected product surface for ask_human. Without it, ask_human fails the run. */
  humanInput?: (question: string) => Promise<unknown>;
  /**
   * Context policy. Deterministic elision, no model call -- a summarisation call
   * would make replay non-deterministic and cost money mid-run.
   */
  compaction?: {
    /** Compact when the estimated input exceeds this. */
    compactAtTokens: number;
    /** Number of trailing messages to keep verbatim. */
    keepRecentMessages: number;
  };
}

export interface RunOptions {
  sessionId?: string;
  budget?: Partial<RunBudget>;
  signal?: AbortSignal;
  runLog?: RunLog;
}

export interface AgentRuntime {
  run(task: Task, options?: RunOptions): AsyncIterable<AgentEvent>;
}

/**
 * The Runtime owns everything the Core refuses to know: run identity, ordered event
 * delivery, budgets, retries, cancellation, persistence and termination.
 *
 * Single-run by design: the instrumented ToolPort shares one event sink. A second
 * concurrent run on the same runtime is rejected rather than silently interleaved.
 */
export function createRuntime(config: RuntimeConfig): AgentRuntime {
  let busy = false;
  let sink: StagedEvent[] | null = null;

  const instrumented: ToolPort = {
    async execute(toolCallId, intent, signal) {
      const active = sink;
      const startedAt = Date.now();
      active?.push(stage({ type: "tool_started", toolCallId, toolName: intent.name }, startedAt));

      if (!isAllowedTool(intent.name)) {
        // Closed by default. A refusal is an action like any other: it must be
        // auditable, replayable, and must make the run honestly partial.
        const refused: Observation = {
          toolCallId,
          name: intent.name,
          ok: false,
          summary: "refused: '" + intent.name + "' is not in the tool allowlist",
          data: null,
          observedAt: Date.now(),
        };
        active?.push(
          stage({
            type: "tool_completed",
            toolCallId,
            toolName: intent.name,
            status: "error",
            error: { code: "invalid_tool", message: refused.summary },
            durationMs: Date.now() - startedAt,
          }),
        );
        active?.push(stage({ type: "observation_added", name: refused.name, observation: refused }, refused.observedAt));
        return refused;
      }

      try {
        const observation = await config.tools.execute(toolCallId, intent, signal);
        active?.push(
          stage(
            {
              type: "tool_completed",
              toolCallId,
              toolName: intent.name,
              status: observation.ok ? "success" : "error",
              result: observation.data,
              durationMs: Date.now() - startedAt,
            },
            Date.now(),
          ),
        );
        active?.push(
          stage({ type: "observation_added", name: observation.name, observation }, observation.observedAt),
        );
        return observation;
      } catch (error) {
        const code = error instanceof PortError ? error.code : "runtime_error";
        const message = error instanceof Error ? error.message : String(error);
        active?.push(
          stage(
            {
              type: "tool_completed",
              toolCallId,
              toolName: intent.name,
              status: "error",
              error: { code, message },
              durationMs: Date.now() - startedAt,
            },
            Date.now(),
          ),
        );
        throw error;
      }
    },
  };

  // The Core still calls decide(state, signal). The Runtime supplies the progress
  // handler, so token deltas are a Runtime concern and Core semantics are untouched.
  let activeDeltas: DeltaQueue | null = null;

  const instrumentedModel: ModelPort = {
    label: config.model.label,
    getLastUsage() {
      return config.model.getLastUsage?.() ?? null;
    },
    decide(state, signal) {
      const queue = activeDeltas;
      if (!queue) return config.model.decide(state, signal);
      return config.model.decide(state, signal, {
        onTextDelta: (delta) => queue.push("text", delta),
        onThinkingDelta: (delta) => queue.push("thinking", delta),
      });
    },
  };

  const core = createCore(instrumentedModel, instrumented);

  async function stepWithRetry(
    state: AgentState,
    signal: AbortSignal,
    budget: RunBudget,
    localSink: StagedEvent[],
  ): Promise<StepOutcome> {
    let attempt = 0;
    for (;;) {
      sink = localSink;
      try {
        return await core.step(state, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const retryable = error instanceof PortError && error.retryable;
        if (!retryable || attempt >= budget.maxRetries) throw error;
        attempt += 1;
        localSink.length = 0; // a retried attempt is not an action; do not report one
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      } finally {
        sink = null;
      }
    }
  }

  return {
    async *run(task, options = {}): AsyncIterable<AgentEvent> {
      if (busy) {
        throw new Error("runtime is single-run: create a separate runtime for concurrent runs");
      }
      busy = true;

      const budget: RunBudget = { ...DEFAULT_BUDGET, ...config.budget, ...options.budget };
      const sessionId = options.sessionId ?? "session-" + randomUUID();
      const runId = randomUUID();
      const publish = createPublisher(runId);
      const runtimeSignal = composeSignal(budget.timeoutMs, options.signal);
      const log = options.runLog ?? config.runLog;
      const startedAt = Date.now();
      const run: Run = {
        runId,
        sessionId,
        taskId: task.id,
        task,
        status: "running",
        startedAt,
        updatedAt: startedAt,
      };

      const emit = async (staged: StagedEvent): Promise<AgentEvent> => {
        const event = publish(staged);
        if (log) await log.appendEvent(event);
        return event;
      };
      const persist = async (status: Run["status"]): Promise<void> => {
        run.status = status;
        run.updatedAt = Date.now();
        if (log) await log.saveRun(run);
      };

      let state = initialState(task);
      let toolCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let usageSeen = false;
      let terminal: StagedEvent | null = null;

      const usageEvent = (): StagedEvent =>
        stage({
          type: "usage_reported",
          usage: {
            inputTokens: usageSeen ? inputTokens : undefined,
            outputTokens: usageSeen ? outputTokens : undefined,
            toolCalls,
            durationMs: Date.now() - startedAt,
            model: config.model.label,
          },
        });

      try {
        if (log) await log.saveRun(run);
        yield await emit(stage({ type: "run_started" }, startedAt));

        while (terminal === null) {
          if (state.iteration >= budget.maxIterations) {
            terminal = stage({
              type: "run_failed",
              error: {
                code: "budget_iterations",
                message: "iteration budget exhausted at " + budget.maxIterations,
              },
            });
            break;
          }
          if (toolCalls >= budget.maxToolCalls) {
            terminal = stage({
              type: "run_failed",
              error: { code: "budget_tools", message: "tool-call budget exhausted at " + budget.maxToolCalls },
            });
            break;
          }

          // Context: compact first, then enforce the hard cap. Compaction that cannot
          // bring the estimate under the cap must fail the run, not silently overrun.
          let estimated = estimateTokens(state.messages);
          const policy = config.compaction;
          if (policy && estimated > policy.compactAtTokens) {
            const compacted = compactContext(state.messages, policy.keepRecentMessages);
            if (compacted.elided > 0) {
              state = { ...state, messages: compacted.messages };
              estimated = estimateTokens(state.messages);
              yield await emit(
                stage({
                  type: "compact_boundary",
                  elided: compacted.elided,
                  keepRecentMessages: policy.keepRecentMessages,
                  estimatedTokens: estimated,
                }),
              );
            }
          }
          if (budget.maxInputTokens !== undefined && estimated > budget.maxInputTokens) {
            terminal = stage({
              type: "run_failed",
              error: {
                code: "budget_input_tokens",
                message: "estimated input " + estimated + " tokens exceeds budget " + budget.maxInputTokens,
              },
            });
            break;
          }

          yield await emit(stage({ type: "model_requested", model: config.model.label }));

          const localSink: StagedEvent[] = [];
          const queue = createDeltaQueue();
          activeDeltas = queue;

          let outcomeValue: StepOutcome | null = null;
          let failure: unknown = null;
          const stepPromise = stepWithRetry(state, runtimeSignal.signal, budget, localSink)
            .then((value) => {
              outcomeValue = value;
            })
            .catch((error: unknown) => {
              failure = error;
            })
            .finally(() => {
              queue.close();
              activeDeltas = null;
            });

          // Interleave: yield tokens while the step is still pending. This is the whole
          // point -- draining after the promise settles would batch everything and the
          // "typewriter" would be theatre.
          for (;;) {
            const item = await queue.next();
            if (item === null) break;
            yield publish(
              stage({
                type: item.kind === "text" ? "text_delta" : "thinking_delta",
                delta: item.delta,
              }),
            );
          }
          await stepPromise;
          if (failure) throw failure;
          const outcome = outcomeValue as StepOutcome | null;
          if (outcome === null) throw new PortError("runtime_error", "step settled without an outcome");

          const previous = state;
          state = outcome.state;

          // The decision logically precedes any action taken for it.
          const decidedAt = localSink.length > 0 ? Math.min(localSink[0].timestamp, Date.now()) : Date.now();
          yield await emit(stage({ type: "decision_made", decision: outcome.decision }, decidedAt));
          for (const staged of localSink) {
            if (staged.body.type === "tool_completed") toolCalls += 1;
            yield await emit(staged);
          }

          const usage = config.model.getLastUsage?.() ?? null;
          if (usage) {
            usageSeen = true;
            inputTokens += usage.inputTokens ?? 0;
            outputTokens += usage.outputTokens ?? 0;
          }

          if (outcome.terminal) {
            terminal = stage({
              type: "run_completed",
              status: outcome.terminal.status,
              result: outcome.terminal.content,
              missingMaterial: outcome.terminal.missingMaterial,
            });
            break;
          }

          if (outcome.decision.kind === "ask_human") {
            const question = outcome.decision.question;
            yield await emit(stage({ type: "human_input_requested", question }));
            if (!config.humanInput) {
              // An unwired human channel is an operational error, not a degraded
              // answer. Failing loudly is the only safe option -- silently continuing
              // would be "proceeding without confirmation", which is exactly what a
              // confirmation gate must never do.
              throw new PortError(
                "runtime_error",
                "ask_human without a human input channel: " + question,
              );
            }
            await persist("awaiting_human");
            const input = await config.humanInput(question);
            yield await emit(stage({ type: "human_input_received", input }));
            yield await emit(stage({ type: "run_resumed" }));
            state = {
              ...state,
              messages: [
                ...state.messages,
                { role: "user", text: typeof input === "string" ? input : JSON.stringify(input) },
              ],
            };
            await persist("running");
          }

          if (outcome.decision.kind === "call_tool" && state.observations.length === previous.observations.length) {
            terminal = stage({
              type: "run_failed",
              error: { code: "no_progress", message: "a tool step produced no observation" },
            });
            break;
          }
        }

        yield await emit(usageEvent());
        if (terminal === null) throw new PortError("runtime_error", "run ended without a terminal event");
        if (terminal.body.type === "run_completed") await persist("completed");
        else if (terminal.body.type === "run_failed") await persist("failed");
        else await persist("cancelled");
        yield await emit(terminal);
      } catch (error) {
        yield await emit(usageEvent());
        const reason = runtimeSignal.reason();
        if (reason === "user" || (runtimeSignal.signal.aborted && reason === null)) {
          await persist("cancelled");
          yield await emit(stage({ type: "run_cancelled" }));
        } else {
          const code: RunErrorCode =
            reason === "timeout"
              ? "budget_timeout"
              : error instanceof PortError
                ? error.code
                : "runtime_error";
          const message = error instanceof Error ? error.message : String(error);
          await persist("failed");
          yield await emit(stage({ type: "run_failed", error: { code, message } }));
        }
      } finally {
        runtimeSignal.dispose();
        busy = false;
      }
    },
  };
}
