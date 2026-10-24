import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryTools, createScriptedModel } from "../src/adapters/fake.ts";
import { createCore } from "../src/core/loop.ts";
import { initialState, type AgentState, type Decision, type ModelPort, type Task } from "../src/core/types.ts";
import type { AgentEvent } from "../src/runtime/events.ts";
import { createJsonlRunLog, replayAgentState, terminalStatus } from "../src/runtime/runlog.ts";
import { createRuntime } from "../src/runtime/run.ts";

const task: Task = {
  id: "r1",
  request: "Make greeting.txt contain hello",
  workspace: ".",
  checkCommand: "memory-check",
};

const script: Decision[] = [
  { kind: "call_tool", toolCallId: "c1", intent: { name: "read_file", arguments: { path: "greeting.txt" } } },
  { kind: "call_tool", toolCallId: "c2", intent: { name: "write_file", arguments: { path: "greeting.txt", content: "hello" } } },
  { kind: "call_tool", toolCallId: "c3", intent: { name: "run_check", arguments: {} } },
  { kind: "respond", content: "done" },
];

const files = { "greeting.txt": "old" };
const check = (f: Readonly<Record<string, string>>) => ({
  command: "memory-check",
  passed: f["greeting.txt"] === "hello",
  output: "greeting.txt=" + String(f["greeting.txt"]),
});

const observe = (state: AgentState) => ({
  iteration: state.iteration,
  filesChanged: state.filesChanged,
  missingMaterial: state.missingMaterial,
  checkPassed: state.check?.passed ?? null,
  observations: state.observations.map((o) => ({ name: o.name, ok: o.ok, summary: o.summary, data: o.data })),
  messageRoles: state.messages.map((m) => m.role),
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("a run has an ordered lifecycle, monotonic sequence and a terminal event", async () => {
  const runtime = createRuntime({ model: createScriptedModel(script), tools: createMemoryTools({ files: { ...files }, check }) });
  const events = await collect(runtime.run(task));

  assert.equal(events[0]?.type, "run_started");
  const last = events.at(-1);
  assert.equal(last?.type, "run_completed");
  assert.equal(last?.type === "run_completed" ? last.status : null, "complete");
  assert.equal(events.filter((e) => e.type === "run_completed").length, 1);
  for (let i = 0; i < events.length; i += 1) {
    assert.equal(events[i]?.sequence, i + 1, "sequence must be monotonic from 1");
  }
  assert.ok(events.some((e) => e.type === "usage_reported"), "every run answers the cost question");
  assert.equal(events.some((e) => e.type === "tool_completed"), true);
});

test("event-log replay reconstructs the state the Core actually reached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinycode-log-"));
  const log = createJsonlRunLog(dir);
  const runtime = createRuntime({
    model: createScriptedModel(script),
    tools: createMemoryTools({ files: { ...files }, check }),
    runLog: log,
  });
  const events = await collect(runtime.run(task));

  const direct = createCore(createScriptedModel(script), createMemoryTools({ files: { ...files }, check }));
  let live = initialState(task);
  for (let i = 0; i < 10; i += 1) {
    const outcome = await direct.step(live, new AbortController().signal);
    live = outcome.state;
    if (outcome.terminal) break;
  }

  const stored = await log.listEvents(events[0]?.runId ?? "");
  assert.equal(stored.length, events.length, "every emitted event must be persisted");
  const recovered = replayAgentState(task, stored);
  assert.deepEqual(observe(recovered), observe(live));
  assert.deepEqual(observe(replayAgentState(task, stored)), observe(recovered), "replay must be idempotent");
  assert.equal(terminalStatus(stored), "completed");
});

test("a refused tool is an auditable, replayable action (regression)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinycode-refuse-"));
  const log = createJsonlRunLog(dir);
  const runtime = createRuntime({
    model: createScriptedModel([
      { kind: "call_tool", toolCallId: "c1", intent: { name: "delete_everything", arguments: { path: "/" } } },
      { kind: "respond", content: "cannot" },
    ]),
    tools: createMemoryTools({ files: {} }),
    runLog: log,
  });
  const events = await collect(runtime.run({ ...task, id: "refuse" }));

  const started = events.filter((e) => e.type === "tool_started");
  const completed = events.filter((e) => e.type === "tool_completed");
  const observed = events.filter((e) => e.type === "observation_added");
  assert.equal(started.length, 1, "a refusal must appear in the trace");
  assert.equal(completed.length, 1);
  assert.equal(observed.length, 1);
  const refusal = observed[0];
  assert.ok(refusal?.type === "observation_added");
  assert.match(refusal.observation.summary, /not in the tool allowlist/);

  const last = events.at(-1);
  assert.equal(last?.type, "run_completed");
  assert.equal(last?.type === "run_completed" ? last.status : null, "partial");

  const recovered = replayAgentState(task, await log.listEvents(events[0]?.runId ?? ""));
  assert.deepEqual(recovered.missingMaterial, ["tool:delete_everything"]);
  assert.equal(recovered.observations.length, 1, "replay must see the refusal, not skip it");
});

test("cancellation stops the run, persists it, and never fakes completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tinycode-cancel-"));
  const log = createJsonlRunLog(dir);
  const controller = new AbortController();
  const runtime = createRuntime({
    model: createScriptedModel(script),
    tools: createMemoryTools({ files: { ...files }, check }),
    runLog: log,
  });

  const events: AgentEvent[] = [];
  for await (const event of runtime.run(task, { signal: controller.signal })) {
    events.push(event);
    if (event.type === "run_started") controller.abort();
  }

  const last = events.at(-1);
  assert.equal(last?.type, "run_cancelled");
  assert.equal(events.some((e) => e.type === "run_completed"), false);
  const stored = await log.listEvents(events[0]?.runId ?? "");
  assert.equal(terminalStatus(stored), "cancelled");
  const run = await log.loadRun(events[0]?.runId ?? "");
  assert.equal(run?.status, "cancelled");
});

test("the iteration budget terminates the run predictably", async () => {
  const looping: Decision[] = Array.from({ length: 10 }, (_, i) => ({
    kind: "call_tool" as const,
    toolCallId: "c" + i,
    intent: { name: "list_files", arguments: {} },
  }));
  const runtime = createRuntime({ model: createScriptedModel(looping), tools: createMemoryTools({ files: {} }) });
  const events = await collect(runtime.run(task, { budget: { maxIterations: 2 } }));

  const last = events.at(-1);
  assert.equal(last?.type, "run_failed");
  assert.equal(last?.type === "run_failed" ? last.error.code : null, "budget_iterations");
});

test("the timeout budget produces budget_timeout, not a silent hang", async () => {
  const hanging: ModelPort = {
    async decide(_state, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      return { kind: "respond", content: "unreachable" };
    },
  };
  const runtime = createRuntime({ model: hanging, tools: createMemoryTools({ files: {} }) });
  const events = await collect(runtime.run(task, { budget: { timeoutMs: 25 } }));

  const last = events.at(-1);
  assert.equal(last?.type, "run_failed");
  assert.equal(last?.type === "run_failed" ? last.error.code : null, "budget_timeout");
});

test("two sessions share no messages, state or observations", async () => {
  const a = createRuntime({ model: createScriptedModel(script), tools: createMemoryTools({ files: { ...files }, check }) });
  const b = createRuntime({ model: createScriptedModel(script), tools: createMemoryTools({ files: { ...files }, check }) });
  const first = await collect(a.run(task, { sessionId: "session-a" }));
  const second = await collect(b.run(task, { sessionId: "session-b" }));

  assert.notEqual(first[0]?.runId, second[0]?.runId);
  const aObs = replayAgentState(task, first).observations.length;
  const bObs = replayAgentState(task, second).observations.length;
  assert.equal(aObs, bObs, "each session replays only its own observations");
  assert.equal(first[0]?.runId === second[0]?.runId, false);
});
