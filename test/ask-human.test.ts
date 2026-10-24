import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryTools, createScriptedModel } from "../src/adapters/fake.ts";
import type { Decision, Task } from "../src/core/types.ts";
import type { AgentEvent } from "../src/runtime/events.ts";
import { createRuntime } from "../src/runtime/run.ts";

const task: Task = { id: "h1", request: "do it", workspace: ".", checkCommand: "true" };

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const asking: Decision[] = [
  { kind: "ask_human", question: "delete the whole repo?" },
  { kind: "call_tool", toolCallId: "c1", intent: { name: "list_files", arguments: {} } },
  { kind: "respond", content: "done" },
];

test("ask_human without a human channel fails loudly instead of proceeding", async () => {
  const runtime = createRuntime({ model: createScriptedModel(asking), tools: createMemoryTools({ files: {} }) });
  const events = await collect(runtime.run(task));

  assert.ok(events.some((e) => e.type === "human_input_requested"), "the question must be in the trace");
  const last = events.at(-1);
  assert.equal(last?.type, "run_failed");
  assert.equal(last?.type === "run_failed" ? last.error.code : null, "runtime_error");
  assert.match(last?.type === "run_failed" ? last.error.message : "", /human input channel/);
  assert.equal(events.some((e) => e.type === "run_completed"), false);
  assert.equal(events.some((e) => e.type === "tool_started"), false, "nothing may execute without confirmation");
});

test("with a human channel the run waits, resumes and continues", async () => {
  const asked: string[] = [];
  const runtime = createRuntime({
    model: createScriptedModel(asking),
    tools: createMemoryTools({ files: { "a.txt": "x" } }),
    humanInput: async (question) => {
      asked.push(question);
      return "yes, go ahead";
    },
  });
  const events = await collect(runtime.run(task));

  assert.deepEqual(asked, ["delete the whole repo?"], "the question reaches the injected channel");
  const kinds = events.map((e) => e.type);
  assert.ok(kinds.includes("human_input_requested"));
  assert.ok(kinds.includes("human_input_received"));
  assert.ok(kinds.includes("run_resumed"));
  assert.ok(kinds.indexOf("human_input_received") < kinds.indexOf("run_resumed"));
  assert.ok(kinds.includes("tool_started"), "after confirmation the tool may run");
  assert.equal(events.at(-1)?.type, "run_completed");
});
