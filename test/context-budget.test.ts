import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryTools, createScriptedModel } from "../src/adapters/fake.ts";
import { estimateTokens } from "../src/core/context.ts";
import type { Decision, Task } from "../src/core/types.ts";
import type { AgentEvent } from "../src/runtime/events.ts";
import { createJsonlRunLog, replayAgentState } from "../src/runtime/runlog.ts";
import { createRuntime } from "../src/runtime/run.ts";

const big = "x".repeat(2000);
const task: Task = {
  id: "ctx",
  request: "read the file several times " + "and keep going ".repeat(10),
  workspace: ".",
  checkCommand: "true",
};

function longScript(steps: number): Decision[] {
  const out: Decision[] = [];
  for (let i = 0; i < steps; i += 1) {
    out.push({ kind: "call_tool", toolCallId: "c" + i, intent: { name: "read_file", arguments: { path: "big.txt" } } });
  }
  out.push({ kind: "respond", content: "done" });
  return out;
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

test("exceeding maxInputTokens fails the run with budget_input_tokens", async () => {
  const runtime = createRuntime({ model: createScriptedModel(longScript(2)), tools: createMemoryTools({ files: { "big.txt": big } }) });
  const events = await collect(runtime.run(task, { budget: { maxInputTokens: 20 } }));

  const last = events.at(-1);
  assert.equal(last?.type, "run_failed");
  assert.equal(last?.type === "run_failed" ? last.error.code : null, "budget_input_tokens");
  assert.equal(events.some((e) => e.type === "model_requested"), false, "no request may be made over budget");
});

test("compaction emits a boundary and lets the run continue", async () => {
  const runtime = createRuntime({
    model: createScriptedModel(longScript(6)),
    tools: createMemoryTools({ files: { "big.txt": big } }),
    compaction: { compactAtTokens: 400, keepRecentMessages: 2 },
  });
  // Room for every tool call: this test is about compaction, not the tool budget.
  const events = await collect(runtime.run(task, { budget: { maxToolCalls: 20 } }));

  const boundaries = events.filter((e) => e.type === "compact_boundary");
  assert.ok(boundaries.length > 0, "expected at least one compaction");
  const first = boundaries[0];
  assert.ok(first && first.type === "compact_boundary" && first.elided > 0);
  assert.equal(events.at(-1)?.type, "run_completed", "the run must survive compaction");

  // The boundary must be followed by at least one model request: that is what makes it
  // a compaction *for* something rather than a trailing artefact.
  const kinds = events.map((e) => e.type);
  const boundaryAt = kinds.indexOf("compact_boundary");
  assert.ok(boundaryAt >= 0 && kinds.indexOf("model_requested", boundaryAt) > boundaryAt);
});

test("replay reproduces the compacted transcript exactly", async () => {
  const log = createJsonlRunLog(await mkdtemp(join(tmpdir(), "tinycode-ctx-")));
  const runtime = createRuntime({
    model: createScriptedModel(longScript(6)),
    tools: createMemoryTools({ files: { "big.txt": big } }),
    runLog: log,
    compaction: { compactAtTokens: 400, keepRecentMessages: 2 },
  });
  const events = await collect(runtime.run(task));
  const stored = await log.listEvents(events[0]?.runId ?? "");

  const boundaries = stored.filter((e) => e.type === "compact_boundary");
  assert.ok(boundaries.length > 0, "the boundary must be persisted, not just live");

  const recovered = replayAgentState(task, stored);
  assert.ok(
    recovered.messages.length < 1 + 6 * 2 + 1,
    "the replayed transcript must be compacted, not the full history",
  );
  assert.deepEqual(replayAgentState(task, stored), recovered, "replay must stay idempotent");

  // REAL cross-check, not a tautology: the live run recorded what it estimated right
  // after compacting. Replaying the log up to that exact event must reproduce the same
  // number -- that is the whole claim of deterministic compaction.
  const lastBoundary = boundaries.at(-1);
  assert.ok(lastBoundary && lastBoundary.type === "compact_boundary");
  const upToBoundary = stored.filter((event) => event.sequence <= lastBoundary.sequence);
  const replayedAtBoundary = replayAgentState(task, upToBoundary);
  assert.equal(
    estimateTokens(replayedAtBoundary.messages),
    lastBoundary.estimatedTokens,
    "replay must land on the token count the live run recorded",
  );
});

test("compaction that cannot get under the cap still fails the run", async () => {
  const runtime = createRuntime({
    model: createScriptedModel(longScript(6)),
    tools: createMemoryTools({ files: { "big.txt": big } }),
    compaction: { compactAtTokens: 400, keepRecentMessages: 50 },
  });
  const events = await collect(runtime.run(task, { budget: { maxInputTokens: 450 } }));

  const last = events.at(-1);
  assert.equal(last?.type, "run_failed");
  assert.equal(last?.type === "run_failed" ? last.error.code : null, "budget_input_tokens");
});
