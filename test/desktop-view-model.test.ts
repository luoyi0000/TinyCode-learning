import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunEventMessage } from "../src/shared/ipc.ts";
import { initialUiState, reduce } from "../src/renderer/src/view-model.ts";

/**
 * The renderer's event handling is a pure reducer, so it is testable without a DOM
 * and without Electron. That matters here: React is not what we want to verify, the
 * event -> visible-state mapping is.
 */

let sequence = 0;
const base = () => ({ runId: "r", sequence: ++sequence, timestamp: 0 });

function feed(events: RunEventMessage[]) {
  return events.reduce(reduce, initialUiState);
}

test("primary text accumulates into the body, detail events do not", () => {
  const state = feed([
    { ...base(), type: "run_started" },
    { ...base(), type: "text_delta", delta: "hello " },
    { ...base(), type: "thinking_delta", delta: "(internal reasoning)" },
    { ...base(), type: "text_delta", delta: "world" },
  ]);
  assert.equal(state.body, "hello world");
  assert.equal(state.body.includes("internal"), false, "thinking must never reach the body");
});

test("tool events land in the trace with a raised tool count", () => {
  const state = feed([
    { ...base(), type: "run_started" },
    { ...base(), type: "decision_made", decision: { kind: "call_tool", toolCallId: "c1", intent: { name: "read_file", arguments: {} } } },
    { ...base(), type: "tool_started", toolCallId: "c1", toolName: "read_file" },
    { ...base(), type: "tool_completed", toolCallId: "c1", toolName: "read_file", status: "success", durationMs: 3 },
  ]);
  assert.equal(state.toolCalls, 1);
  assert.equal(state.trace.length, 3);
  assert.ok(state.trace[2]?.text.includes("read_file"));
  assert.equal(state.trace[2]?.tone, "good");
});

test("a partial verdict surfaces the missing material, not just a status", () => {
  const state = feed([
    { ...base(), type: "run_started" },
    { ...base(), type: "text_delta", delta: "I could not do it" },
    { ...base(), type: "run_completed", status: "partial", result: "I could not do it", missingMaterial: ["tool:delete_everything"] },
  ]);
  assert.equal(state.phase, "finished");
  assert.equal(state.verdict?.status, "partial");
  assert.deepEqual(state.verdict?.missing, ["tool:delete_everything"]);
});

test("a failure and a cancellation are distinguishable terminal states", () => {
  const failed = feed([
    { ...base(), type: "run_started" },
    { ...base(), type: "run_failed", error: { code: "auth", message: "no key" } },
  ]);
  assert.equal(failed.verdict?.status, "failed");
  assert.match(failed.verdict?.message ?? "", /auth/);

  const cancelled = feed([{ ...base(), type: "run_started" }, { ...base(), type: "run_cancelled" }]);
  assert.equal(cancelled.verdict?.status, "cancelled");
});

test("a new run_started resets the previous run completely", () => {
  const first = feed([
    { ...base(), type: "run_started" },
    { ...base(), type: "text_delta", delta: "old answer" },
    { ...base(), type: "tool_completed", toolCallId: "c", toolName: "read_file", status: "success", durationMs: 1 },
  ]);
  assert.ok(first.body.length > 0);
  const second = reduce(first, { ...base(), type: "run_started" });
  assert.equal(second.body, "");
  assert.equal(second.trace.length, 0);
  assert.equal(second.phase, "running");
});

test("compaction is shown in the trace as a warning", () => {
  const state = feed([
    { ...base(), type: "run_started" },
    { ...base(), type: "compact_boundary", elided: 4, keepRecentMessages: 2, estimatedTokens: 500 },
  ]);
  assert.equal(state.trace[0]?.tone, "warn");
  assert.match(state.trace[0]?.text ?? "", /dropped 4/);
});

