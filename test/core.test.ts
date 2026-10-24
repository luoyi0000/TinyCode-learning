import { test } from "node:test";
import assert from "node:assert/strict";

import { createCore } from "../src/core/loop.ts";
import { createMemoryTools, createScriptedModel } from "../src/adapters/fake.ts";
import { initialState, type AgentState, type Decision, type RunResult, type Task } from "../src/core/types.ts";

const task: Task = {
  id: "t1",
  request: "Make a.txt contain hello",
  workspace: ".",
  checkCommand: "memory-check",
};

const signal = () => new AbortController().signal;

async function drive(
  decisions: Decision[],
  opts: { files?: Record<string, string>; check?: (f: Readonly<Record<string, string>>) => { command: string; passed: boolean; output: string } } = {},
): Promise<{ states: AgentState[]; terminal: RunResult; files: Record<string, string> }> {
  const model = createScriptedModel(decisions);
  const tools = createMemoryTools(opts);
  const core = createCore(model, tools);

  let state = initialState(task);
  const states: AgentState[] = [];
  for (let i = 0; i < 20; i += 1) {
    const outcome = await core.step(state, signal());
    states.push(outcome.state);
    state = outcome.state;
    if (outcome.terminal) return { states, terminal: outcome.terminal, files: tools.files };
  }
  throw new Error("core did not terminate within 20 steps");
}

test("happy path reaches complete and records changed files", async () => {
  const { terminal, files, states } = await drive([
    { kind: "call_tool", toolCallId: "c1", intent: { name: "list_files", arguments: {} } },
    { kind: "call_tool", toolCallId: "c2", intent: { name: "read_file", arguments: { path: "a.txt" } } },
    { kind: "call_tool", toolCallId: "c3", intent: { name: "write_file", arguments: { path: "a.txt", content: "hello" } } },
    { kind: "call_tool", toolCallId: "c4", intent: { name: "run_check", arguments: {} } },
    { kind: "respond", content: "a.txt now contains hello" },
  ], {
    files: { "a.txt": "old" },
    check: (f) => ({ command: "memory-check", passed: f["a.txt"] === "hello", output: "a.txt=" + String(f["a.txt"]) }),
  });

  assert.equal(terminal.status, "complete");
  assert.deepEqual(terminal.missingMaterial, []);
  assert.deepEqual(files["a.txt"], "hello");
  const last = states.at(-1);
  assert.ok(last);
  assert.deepEqual(last.filesChanged, ["a.txt"]);
  assert.equal(last.observations.length, 4);
  assert.ok(last.observations.every((o) => o.ok));
});

test("an unknown tool cannot succeed, and the run is honestly partial", async () => {
  const { terminal, states } = await drive([
    { kind: "call_tool", toolCallId: "c1", intent: { name: "delete_everything", arguments: { path: "/" } } },
    { kind: "respond", content: "I could not delete everything" },
  ]);

  // The allowlist lives in the tool port (see the runtime regression test); the Core
  // still classifies an unknown-tool failure as missing material rather than a tool error.
  assert.equal(terminal.status, "partial");
  assert.deepEqual(terminal.missingMaterial, ["tool:delete_everything"]);
  const refused = states[0]?.observations[0];
  assert.ok(refused);
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /invalid_tool/);
});

test("a failed check makes the run partial, and a later passing check retracts it", async () => {
  const check = (f: Readonly<Record<string, string>>) => ({
    command: "memory-check",
    passed: f["a.txt"] === "hello",
    output: "a.txt=" + String(f["a.txt"]),
  });

  const failing = await drive([
    { kind: "call_tool", toolCallId: "c1", intent: { name: "run_check", arguments: {} } },
    { kind: "respond", content: "gave up" },
  ], { files: { "a.txt": "old" }, check });

  assert.equal(failing.terminal.status, "partial");
  assert.deepEqual(failing.terminal.missingMaterial, ["check_failed:memory-check"]);

  const recovered = await drive([
    { kind: "call_tool", toolCallId: "c1", intent: { name: "run_check", arguments: {} } },
    { kind: "call_tool", toolCallId: "c2", intent: { name: "write_file", arguments: { path: "a.txt", content: "hello" } } },
    { kind: "call_tool", toolCallId: "c3", intent: { name: "run_check", arguments: {} } },
    { kind: "respond", content: "fixed" },
  ], { files: { "a.txt": "old" }, check });

  assert.equal(recovered.terminal.status, "complete");
  assert.deepEqual(recovered.terminal.missingMaterial, []);
});

test("a failing tool is visible and never corrupts unrelated state", async () => {
  const { terminal, states } = await drive([
    { kind: "call_tool", toolCallId: "c1", intent: { name: "read_file", arguments: { path: "missing.txt" } } },
    { kind: "call_tool", toolCallId: "c2", intent: { name: "list_files", arguments: {} } },
    { kind: "respond", content: "listed anyway" },
  ], { files: { "a.txt": "x" } });

  const failed = states[0]?.observations[0];
  assert.ok(failed);
  assert.equal(failed.ok, false);
  // The next action is unaffected: the failure is isolated, not contagious.
  assert.equal(states[1]?.observations[1]?.ok, true);
  assert.deepEqual(states[1]?.observations[1]?.data, ["a.txt"]);
  // But the run may not claim success: material the agent asked for was not there.
  assert.equal(terminal.status, "partial");
  assert.deepEqual(terminal.missingMaterial, ["tool_error:read_file"]);
});

test("answering without a single observation is partial, not complete", async () => {
  // Real finding: a tool-less agent answered a question about a file it never read
  // and reported complete. No evidence must mean no complete.
  const { terminal, states } = await drive([
    { kind: "respond", content: "greeting.txt probably says hello" },
  ]);

  assert.equal(terminal.status, "partial");
  assert.deepEqual(terminal.missingMaterial, ["evidence:no observation recorded"]);
  assert.equal(states[0]?.observations.length, 0);
});

test("a write with no following check is partial, not complete (live finding)", async () => {
  // Exact shape of the qwen2.5:7b live failure: read ok, write ok with the wrong
  // content, then the model emitted a tool call as plain text. Two observations
  // were recorded, yet the task was never proven done.
  const { terminal, states } = await drive(
    [
      { kind: "call_tool", toolCallId: "c1", intent: { name: "read_file", arguments: { path: "a.txt" } } },
      { kind: "call_tool", toolCallId: "c2", intent: { name: "write_file", arguments: { path: "a.txt", content: "hello tinycode." } } },
      { kind: "respond", content: ' Ronaldo {"name": "run_check", "arguments": {}}' },
    ],
    { files: { "a.txt": "old" }, check: (f) => ({ command: "memory-check", passed: f["a.txt"] === "hello tinycode", output: "x" }) },
  );

  assert.equal(terminal.status, "partial");
  assert.deepEqual(terminal.missingMaterial, ["check:required_after_change"]);
  assert.deepEqual(states.at(-1)?.filesChanged, ["a.txt"]);
});

test("a check that ran before the last write does not count as evidence", async () => {
  const check = (f: Readonly<Record<string, string>>) => ({
    command: "memory-check",
    passed: f["a.txt"] === "good",
    output: String(f["a.txt"]),
  });

  const { terminal, states } = await drive(
    [
      { kind: "call_tool", toolCallId: "c1", intent: { name: "write_file", arguments: { path: "a.txt", content: "good" } } },
      { kind: "call_tool", toolCallId: "c2", intent: { name: "run_check", arguments: {} } },
      { kind: "call_tool", toolCallId: "c3", intent: { name: "write_file", arguments: { path: "a.txt", content: "bad" } } },
      { kind: "respond", content: "done" },
    ],
    { files: {}, check },
  );

  // The passing check was invalidated by the later write.
  assert.equal(states[1]?.check?.passed, true);
  assert.equal(states[2]?.check, null);
  assert.equal(terminal.status, "partial");
  assert.deepEqual(terminal.missingMaterial, ["check:required_after_change"]);
});

test("step never mutates the state it is given", async () => {
  const model = createScriptedModel([
    { kind: "call_tool", toolCallId: "c1", intent: { name: "write_file", arguments: { path: "b.txt", content: "y" } } },
  ]);
  const core = createCore(model, createMemoryTools({ files: {} }));
  const before = initialState(task);
  const snapshot = structuredClone(before);

  await core.step(before, signal());
  assert.deepEqual(before, snapshot);
});
