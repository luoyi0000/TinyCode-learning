import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import { createMemoryTools } from "../src/adapters/fake.ts";
import { createPiModelPort } from "../src/adapters/pi.ts";
import type { Task } from "../src/core/types.ts";
import type { AgentEvent } from "../src/runtime/events.ts";
import { createJsonlRunLog } from "../src/runtime/runlog.ts";
import { createRuntime } from "../src/runtime/run.ts";

/**
 * Streaming is only real if tokens reach the consumer BEFORE the decision does.
 * These tests pin that ordering, not just the presence of delta events -- batching
 * every token and flushing after the step would also "have" deltas.
 */

const task: Task = { id: "s1", request: "say something", workspace: ".", checkCommand: "true" };

function streamingModel(text: string) {
  const faux = fauxProvider({ tokensPerSecond: 200_000, tokenSize: { min: 2, max: 4 } });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(text)]);
  return createPiModelPort({ models, model: faux.getModel(), specs: [] });
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

test("token deltas are yielded before the decision that contains them", async () => {
  const text = "hello tinycode streaming works end to end";
  const port = streamingModel(text);
  const runtime = createRuntime({ model: port, tools: createMemoryTools({ files: {} }) });
  const events = await collect(runtime.run(task));

  const firstDelta = events.findIndex((e) => e.type === "text_delta");
  const decision = events.findIndex((e) => e.type === "decision_made");
  assert.ok(firstDelta >= 0, "expected at least one text_delta");
  assert.ok(decision >= 0, "expected a decision_made");
  assert.ok(firstDelta < decision, "deltas must arrive before the decision, not after");

  const joined = events.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.delta : "")).join("");
  assert.equal(joined, text, "deltas must concatenate to the final content");

  const last = events.at(-1);
  assert.equal(last?.type, "run_completed");
  assert.equal(last?.type === "run_completed" ? last.result : null, text);
});

test("sequence stays monotonic across deltas", async () => {
  const runtime = createRuntime({ model: streamingModel("one two three four"), tools: createMemoryTools({ files: {} }) });
  const events = await collect(runtime.run(task));
  events.forEach((event, index) => assert.equal(event.sequence, index + 1));
});

test("deltas are transient: they never enter the run log", async () => {
  const log = createJsonlRunLog(await mkdtemp(join(tmpdir(), "tinycode-stream-")));
  const runtime = createRuntime({
    model: streamingModel("audit the change please"),
    tools: createMemoryTools({ files: {} }),
    runLog: log,
  });
  const events = await collect(runtime.run(task));
  const runId = events[0]?.runId ?? "";

  const live = events.filter((e) => e.type === "text_delta").length;
  assert.ok(live > 0, "the live stream must carry deltas");

  const stored = await log.listEvents(runId);
  assert.equal(stored.filter((e) => e.type === "text_delta").length, 0);
  assert.ok(stored.length < events.length, "the log must be smaller than the live stream");
  // The log is still the source of truth for the outcome.
  const lastStored = stored.at(-1);
  assert.equal(lastStored?.type, "run_completed");
});
