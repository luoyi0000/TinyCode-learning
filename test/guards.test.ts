import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { createMemoryTools, createScriptedModel } from "../src/adapters/fake.ts";
import { PortError, type Decision, type ModelPort, type Task } from "../src/core/types.ts";
import { createRuntime } from "../src/runtime/run.ts";
import { replayAgentState, terminalStatus } from "../src/runtime/runlog.ts";
import type { AgentEvent } from "../src/runtime/events.ts";

const task: Task = { id: "g1", request: "go", workspace: ".", checkCommand: "memory-check" };

function flaky(failFirst: number, code: "rate_limited" | "auth"): { port: ModelPort; attempts: () => number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    port: {
      async decide(): Promise<Decision> {
        attempts += 1;
        if (attempts <= failFirst) throw new PortError(code, code + " while calling provider", code === "rate_limited");
        return { kind: "respond", content: "recovered" };
      },
    },
  };
}

async function collect(iterable: AsyncIterable<unknown>): Promise<Array<{ type: string; error?: { code: string } }>> {
  const out: Array<{ type: string; error?: { code: string } }> = [];
  for await (const event of iterable) out.push(event as { type: string; error?: { code: string } });
  return out;
}

test("a retryable provider error is retried within the budget, then succeeds", async () => {
  const { port, attempts } = flaky(2, "rate_limited");
  const runtime = createRuntime({ model: port, tools: createMemoryTools({ files: {} }) });
  const events = await collect(runtime.run(task, { budget: { maxRetries: 2 } }));

  assert.equal(attempts(), 3, "two retries then success");
  assert.equal(events.at(-1)?.type, "run_completed");
});

test("a non-retryable error is never retried and fails with its own code", async () => {
  const { port, attempts } = flaky(1, "auth");
  const runtime = createRuntime({ model: port, tools: createMemoryTools({ files: {} }) });
  const events = await collect(runtime.run(task, { budget: { maxRetries: 3 } }));

  assert.equal(attempts(), 1, "auth failures must not be retried");
  const last = events.at(-1);
  assert.equal(last?.type, "run_failed");
  assert.equal(last?.error?.code, "auth");
});

test("the tool-call budget terminates the run", async () => {
  const looping: Decision[] = Array.from({ length: 8 }, (_, i) => ({
    kind: "call_tool" as const,
    toolCallId: "c" + i,
    intent: { name: "list_files", arguments: {} },
  }));
  const runtime = createRuntime({ model: createScriptedModel(looping), tools: createMemoryTools({ files: {} }) });
  const events = await collect(runtime.run(task, { budget: { maxToolCalls: 2 } }));

  const last = events.at(-1);
  assert.equal(last?.error?.code, "budget_tools");
});

test("a log truncated by a crash reports non-terminal instead of faking success", async () => {
  const runtime = createRuntime({
    model: createScriptedModel([
      { kind: "call_tool", toolCallId: "c1", intent: { name: "list_files", arguments: {} } },
      { kind: "respond", content: "done" },
    ]),
    tools: createMemoryTools({ files: {} }),
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.run(task)) events.push(event);

  // Simulate a crash after the first observation landed: durable but unfinished.
  const upToFirstObservation = events.findIndex((event) => event.type === "observation_added") + 1;
  const truncated = events.slice(0, upToFirstObservation);
  assert.equal(terminalStatus(truncated), "running", "an unfinished log must not claim success");
  const recovered = replayAgentState(task, truncated);
  assert.equal(recovered.iteration, 1, "durable progress is not lost");
  assert.equal(recovered.observations.length, 1);

  // Before the observation is durable, replay reports exactly that: nothing applied yet.
  const beforeObservation = events.slice(0, upToFirstObservation - 1);
  assert.equal(replayAgentState(task, beforeObservation).iteration, 0);
  assert.equal(terminalStatus(events), "completed");
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("the SDK is imported in exactly one file: the Pi adapter", async () => {
  const root = resolve(process.cwd(), "src");
  const files = await walk(root);
  const importers: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (text.includes("@earendil-works/")) importers.push(file.slice(root.length + 1).split(sep).join("/"));
  }
  assert.deepEqual(importers, ["adapters/pi.ts"]);
});

test("our code never reads credentials: the SDK auth store owns them", async () => {
  // The invariant is about CREDENTIALS, not about env access in general: the Electron
  // main process legitimately reads ELECTRON_RENDERER_URL. Reading an API key is what
  // must never happen here -- the SDK's auth layer owns that.
  const root = resolve(process.cwd(), "src");
  const files = await walk(root);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.equal(
      /process\.env\.[A-Z0-9_]*(_KEY|_TOKEN|_SECRET|_PASSWORD)/.test(text),
      false,
      "credential env read in " + file,
    );
    assert.equal(/sk-[A-Za-z0-9]{16,}/.test(text), false, "secret literal in " + file);
  }
});
