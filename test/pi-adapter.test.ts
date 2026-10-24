import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { createPiModelPort, createSandboxToolPort, mapProviderError, toPiTool } from "../src/adapters/pi.ts";
import { createMemoryTools, createScriptedModel } from "../src/adapters/fake.ts";
import { createCore } from "../src/core/loop.ts";
import { TOOL_SPECS } from "../src/core/policy.ts";
import { PortError, initialState, type AgentState, type Decision, type Task } from "../src/core/types.ts";

const task: Task = {
  id: "p1",
  request: "Make a.txt contain hello",
  workspace: ".",
  checkCommand: "memory-check",
};
const freshSignal = () => new AbortController().signal;

function fauxModel(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const port = createPiModelPort({ models, model: faux.getModel() });
  return { faux, models, port };
}

/** Turn a decision script into the exact provider responses the real adapter must decode. */
function toFaux(decision: Decision) {
  switch (decision.kind) {
    case "call_tool":
      return fauxAssistantMessage([fauxToolCall(decision.intent.name, decision.intent.arguments)], {
        stopReason: "toolUse",
      });
    case "respond":
      return fauxAssistantMessage(decision.content, { stopReason: "stop" });
    case "ask_human":
      return fauxAssistantMessage(decision.question, { stopReason: "stop" });
  }
}

test("real adapter decodes a provider tool call into a Core Decision", async () => {
  const { port } = fauxModel([fauxAssistantMessage([fauxToolCall("read_file", { path: "a.txt" })], { stopReason: "toolUse" })]);
  const decision = await port.decide(initialState(task), freshSignal());

  assert.equal(decision.kind, "call_tool");
  assert.ok(decision.kind === "call_tool");
  assert.equal(decision.intent.name, "read_file");
  assert.deepEqual(decision.intent.arguments, { path: "a.txt" });
  assert.ok(decision.toolCallId.length > 0);
});

test("real adapter decodes a text stop into respond and reports usage", async () => {
  const { port } = fauxModel([fauxAssistantMessage("all done", { stopReason: "stop" })]);
  const decision = await port.decide(initialState(task), freshSignal());

  assert.deepEqual(decision, { kind: "respond", content: "all done" });
  const usage = port.getLastUsage();
  assert.ok(usage, "usage must be captured for usage_reported");
  assert.equal(typeof usage.outputTokens, "number");
});

test("real adapter normalizes a provider error into a typed PortError", async () => {
  const { port } = fauxModel([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "402 Insufficient Balance" }),
  ]);

  await assert.rejects(
    () => port.decide(initialState(task), freshSignal()),
    (error: unknown) => {
      assert.ok(error instanceof PortError);
      assert.equal(error.code, "provider_unavailable");
      return true;
    },
  );
});

test("error taxonomy covers the codes the Runtime must retry or refuse", () => {
  assert.equal(mapProviderError("402 Insufficient Balance").code, "provider_unavailable");
  assert.equal(mapProviderError("402 Insufficient Balance").retryable, false);
  assert.equal(mapProviderError("401 Unauthorized: invalid api key").code, "auth");
  assert.equal(mapProviderError("429 Too Many Requests").code, "rate_limited");
  assert.equal(mapProviderError("429 Too Many Requests").retryable, true);
  assert.equal(mapProviderError("fetch failed: ETIMEDOUT").retryable, true);
  assert.equal(mapProviderError(undefined).code, "provider_unavailable");
});

test("cancellation rejects in-flight model work when the signal fires", async () => {
  const { port } = fauxModel([fauxAssistantMessage("never used")]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => port.decide(initialState(task), controller.signal));
});

test("tool specs map to the SDK tool shape the model actually sees", () => {
  for (const spec of TOOL_SPECS) {
    const mapped = toPiTool(spec);
    assert.equal(mapped.name, spec.name);
    assert.equal(mapped.description, spec.description);
    assert.ok(mapped.parameters, "parameters must survive the TypeBox mapping");
  }
});

test("fake and real adapters produce the same Core semantics (golden equivalence)", async () => {
  const script: Decision[] = [
    { kind: "call_tool", toolCallId: "c1", intent: { name: "read_file", arguments: { path: "a.txt" } } },
    { kind: "call_tool", toolCallId: "c2", intent: { name: "write_file", arguments: { path: "a.txt", content: "hello" } } },
    { kind: "call_tool", toolCallId: "c3", intent: { name: "run_check", arguments: {} } },
    { kind: "respond", content: "a.txt now contains hello" },
  ];
  const files = { "a.txt": "old" };
  const check = (f: Readonly<Record<string, string>>) => ({
    command: "memory-check",
    passed: f["a.txt"] === "hello",
    output: "a.txt=" + String(f["a.txt"]),
  });

  async function drive(state: AgentState, core: ReturnType<typeof createCore>) {
    const states: AgentState[] = [];
    for (let i = 0; i < 20; i += 1) {
      const outcome = await core.step(state, freshSignal());
      states.push(outcome.state);
      state = outcome.state;
      if (outcome.terminal) return { states, terminal: outcome.terminal };
    }
    throw new Error("did not terminate");
  }

  const fakeCore = createCore(createScriptedModel(script), createMemoryTools({ files: { ...files }, check }));
  const fakeRun = await drive(initialState(task), fakeCore);

  const { port } = fauxModel(script.map(toFaux));
  const realCore = createCore(port, createMemoryTools({ files: { ...files }, check }));
  const realRun = await drive(initialState(task), realCore);

  // Same decisions, same observations, same terminal verdict: only the transport differed.
  assert.deepEqual(fakeRun.terminal, realRun.terminal);
  assert.equal(fakeRun.terminal.status, "complete");
  const shape = (run: typeof fakeRun) =>
    run.states.map((s) =>
      s.observations.map((o) => ({ name: o.name, ok: o.ok, data: o.data, summary: o.summary })),
    );
  assert.deepEqual(shape(fakeRun), shape(realRun));
});

test("sandbox tools really read, write, refuse escapes and run the check command", async () => {
  const root = await mkdtemp(join(tmpdir(), "tinycode-"));
  const passing = createSandboxToolPort({ root, checkCommand: "node --version" });
  const failing = createSandboxToolPort({ root, checkCommand: "node --no-such-flag-tinycode" });

  const wrote = await passing.execute("w1", { name: "write_file", arguments: { path: "nested/a.txt", content: "hello" } }, freshSignal());
  assert.equal(wrote.ok, true);
  assert.equal(await readFile(join(root, "nested", "a.txt"), "utf8"), "hello");

  const read = await passing.execute("r1", { name: "read_file", arguments: { path: "nested/a.txt" } }, freshSignal());
  assert.equal(read.data, "hello");

  const listed = await passing.execute("l1", { name: "list_files", arguments: { dir: "nested" } }, freshSignal());
  assert.deepEqual(listed.data, ["nested/a.txt"]);

  await assert.rejects(
    () => passing.execute("x1", { name: "read_file", arguments: { path: "../escape.txt" } }, freshSignal()),
    (error: unknown) => error instanceof PortError && error.code === "invalid_tool",
  );

  const ok = await passing.execute("c1", { name: "run_check", arguments: {} }, freshSignal());
  assert.equal(ok.ok, true);
  assert.equal((ok.data as { passed: boolean }).passed, true);

  const bad = await failing.execute("c2", { name: "run_check", arguments: {} }, freshSignal());
  assert.equal(bad.ok, true, "the check ran; its verdict is what failed");
  assert.equal((bad.data as { passed: boolean }).passed, false);
});
