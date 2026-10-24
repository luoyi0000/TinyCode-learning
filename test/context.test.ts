import { test } from "node:test";
import assert from "node:assert/strict";

import { compactContext, estimateTokens, isBoundaryMessage } from "../src/core/context.ts";
import type { ChatMessage } from "../src/core/types.ts";

function transcript(turns: number): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "user", text: "the original task" }];
  for (let i = 0; i < turns; i += 1) {
    out.push({ role: "assistant", text: "", toolCalls: [{ id: "c" + i, name: "read_file", arguments: { path: "f" + i } }] });
    out.push({ role: "tool", toolCallId: "c" + i, name: "read_file", text: "contents of f" + i, ok: true });
  }
  return out;
}

test("the estimate grows with content and is 0 for an empty transcript", () => {
  assert.equal(estimateTokens([]), 0);
  const small = estimateTokens([{ role: "user", text: "hi" }]);
  const big = estimateTokens([{ role: "user", text: "hi".repeat(400) }]);
  assert.ok(big > small * 10, "estimate must scale with length");
});

test("compaction keeps the task, keeps recent turns, and drops the middle", () => {
  const messages = transcript(10);
  const before = estimateTokens(messages);
  const result = compactContext(messages, 4);

  assert.ok(result.elided > 0, "something must be dropped");
  assert.ok(result.messages.length < messages.length);
  assert.ok(estimateTokens(result.messages) < before, "compaction must actually shrink the context");
  assert.deepEqual(result.messages[0], { role: "user", text: "the original task" }, "the task is never dropped");
  assert.ok(isBoundaryMessage(result.messages[1] as ChatMessage), "a boundary message replaces what was dropped");
});

test("the boundary message names what was dropped so the model can recover", () => {
  const result = compactContext(transcript(6), 2);
  const boundary = result.messages.find(isBoundaryMessage);
  assert.ok(boundary && boundary.role === "user");
  assert.match(boundary.text, /dropped tool results: read_file/i);
  assert.match(boundary.text, /Re-read files/);
});

test("compaction is deterministic and idempotent enough to replay", () => {
  const messages = transcript(8);
  const a = compactContext(messages, 4);
  const b = compactContext(messages, 4);
  assert.deepEqual(a, b, "same input + same policy must give the same result");
  const twice = compactContext(a.messages, 4);
  assert.equal(twice.elided, 0, "compacting an already-compact context is a no-op");
});

test("a tool result is never separated from its call", () => {
  const result = compactContext(transcript(8), 3);
  const firstKept = result.messages[2];
  assert.ok(firstKept, "expected a kept turn");
  assert.notEqual(firstKept.role, "tool", "the kept window must not start with an orphan tool result");
});

test("nothing is dropped when everything already fits", () => {
  const messages = transcript(1);
  const result = compactContext(messages, 50);
  assert.equal(result.elided, 0);
  assert.deepEqual(result.messages, messages);
});
