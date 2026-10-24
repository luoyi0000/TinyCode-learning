import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { compactContext } from "../core/context.ts";
import { applyToolStep } from "../core/loop.ts";
import { initialState, type AgentState, type Decision, type Task } from "../core/types.ts";
import type { AgentEvent } from "./events.ts";

/**
 * The append-only event log is the source of truth for a run. A snapshot may only
 * ever be a cache, and replay must be idempotent.
 */

export type RunStatus = "queued" | "running" | "awaiting_human" | "completed" | "failed" | "cancelled";

export interface Run {
  runId: string;
  sessionId: string;
  taskId: string;
  /**
   * The task this run was given. Stored, not inferred: replay needs it to rebuild
   * state, and a log that cannot be replayed without out-of-band knowledge is not
   * a durable record.
   */
  task: Task;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  createdAt: number;
  runs: Run[];
}

export interface RunLog {
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(runId: string): Promise<AgentEvent[]>;
  saveRun(run: Run): Promise<void>;
  loadRun(runId: string): Promise<Run | undefined>;
}

export interface JsonlRunLog extends RunLog {
  readonly dir: string;
}

export function createJsonlRunLog(dir: string): JsonlRunLog {
  const eventsDir = join(dir, "events");
  const runsDir = join(dir, "runs");
  const eventsPath = (runId: string) => join(eventsDir, runId + ".jsonl");
  const runPath = (runId: string) => join(runsDir, runId + ".json");

  return {
    dir,
    async appendEvent(event) {
      // One file per run keeps concurrent runs isolated.
      await mkdir(eventsDir, { recursive: true });
      await appendFile(eventsPath(event.runId), JSON.stringify(event) + "\n", "utf8");
    },
    async listEvents(runId) {
      const raw = await readFile(eventsPath(runId), "utf8").catch(() => "");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AgentEvent)
        .sort((a, b) => a.sequence - b.sequence);
    },
    async saveRun(run) {
      await mkdir(runsDir, { recursive: true });
      await writeFile(runPath(run.runId), JSON.stringify(run, null, 2) + "\n", "utf8");
    },
    async loadRun(runId) {
      const raw = await readFile(runPath(runId), "utf8").catch(() => null);
      return raw === null ? undefined : (JSON.parse(raw) as Run);
    },
  };
}

/**
 * Rebuild AgentState by applying the log in sequence order. It reuses the Core's own
 * transition function, so a recovered state cannot silently drift from a live one.
 * Idempotent: replaying the same log twice yields the same state.
 */
export function replayAgentState(task: Task, events: readonly AgentEvent[]): AgentState {
  let state = initialState(task);
  let pending: Extract<Decision, { kind: "call_tool" }> | null = null;

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "decision_made") {
      pending = event.decision.kind === "call_tool" ? event.decision : null;
    } else if (event.type === "observation_added" && pending) {
      state = applyToolStep(state, pending, event.observation);
      pending = null;
    } else if (event.type === "compact_boundary") {
      // Same policy, same input => same transcript. This is why compaction is
      // deterministic instead of a model call.
      state = { ...state, messages: compactContext(state.messages, event.keepRecentMessages).messages };
    }
  }
  return state;
}

/** Terminal status derived from the log, not from memory. */
export function terminalStatus(events: readonly AgentEvent[]): RunStatus {
  for (const event of events) {
    if (event.type === "run_completed") return "completed";
    if (event.type === "run_failed") return "failed";
    if (event.type === "run_cancelled") return "cancelled";
  }
  return "running";
}
