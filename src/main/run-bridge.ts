import type { Task, ModelPort, ToolPort } from "../core/types.ts";
import type { AgentEvent } from "../runtime/events.ts";
import { createRuntime } from "../runtime/run.ts";
import { createJsonlRunLog } from "../runtime/runlog.ts";

/**
 * Executes one run and pushes every product event through `send`.
 *
 * Deliberately free of electron imports: the main process is only a thin shell around
 * this, which means the whole event-push path can be tested in plain Node with fake
 * ports. The renderer never sees a raw SDK callback -- `send` only ever receives an
 * AgentEvent.
 */
export interface RunBridgeDeps {
  modelPort: ModelPort;
  toolPort: ToolPort;
  task: Task;
  logDir: string;
  send: (event: AgentEvent) => void;
  signal: AbortSignal;
}

export async function executeRun(deps: RunBridgeDeps): Promise<void> {
  const runtime = createRuntime({
    model: deps.modelPort,
    tools: deps.toolPort,
    runLog: createJsonlRunLog(deps.logDir),
  });

  try {
    for await (const event of runtime.run(deps.task, { signal: deps.signal })) {
      deps.send(event);
    }
  } catch (error) {
    // The runtime normally reports its own failures as events; this catch covers the
    // case where starting the run itself threw, so the renderer still gets a terminal.
    deps.send({
      type: "run_failed",
      runId: deps.task.id,
      sequence: -1,
      timestamp: Date.now(),
      error: {
        code: "runtime_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
