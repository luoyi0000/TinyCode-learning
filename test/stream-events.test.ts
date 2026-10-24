import { test } from "node:test";
import assert from "node:assert/strict";

import { createPublisher, stage } from "../src/runtime/events.ts";
import { isTerminalEvent, sseFrame, toStreamEvent } from "../src/runtime/stream-events.ts";

const publish = createPublisher("run-x");

test("primary vs detail is decided by the event type, not by the client", () => {
  const text = toStreamEvent(publish(stage({ type: "text_delta", delta: "hi" })));
  assert.equal(text.displayLevel, "primary");
  assert.equal(text.type, "text_delta");

  const thinking = toStreamEvent(publish(stage({ type: "thinking_delta", delta: "hmm" })));
  assert.equal(thinking.displayLevel, "detail");
});

test("tools and usage map to the detail channel with paired start/end", () => {
  const start = toStreamEvent(publish(stage({ type: "tool_started", toolCallId: "c1", toolName: "read_file" })));
  const end = toStreamEvent(
    publish(stage({ type: "tool_completed", toolCallId: "c1", toolName: "read_file", status: "success", durationMs: 3 })),
  );
  assert.equal(start.type, "tool_use_start");
  assert.equal(end.type, "tool_use_end");
  assert.deepEqual([start.displayLevel, end.displayLevel], ["detail", "detail"]);
  assert.equal(end.payload.toolCallId, "c1", "start and end must be pairable");

  const usage = toStreamEvent(publish(stage({ type: "usage_reported", usage: { toolCalls: 1, durationMs: 9 } })));
  assert.equal(usage.type, "usage");
});

test("an observation keeps its identity and verdict, not an empty payload", () => {
  const mapped = toStreamEvent(
    publish(
      stage({
        type: "observation_added",
        name: "run_check",
        observation: { toolCallId: "c1", name: "run_check", ok: true, summary: "check passed", data: null, observedAt: 1 },
      }),
    ),
  );
  assert.equal(mapped.type, "observation");
  assert.equal(mapped.payload.name, "run_check");
  assert.equal(mapped.payload.ok, true);
});

test("every termination maps to one terminal frame", () => {
  const done = toStreamEvent(publish(stage({ type: "run_completed", status: "partial", result: "x", missingMaterial: ["m"] })));
  assert.equal(done.type, "end");
  assert.equal(done.displayLevel, "terminal");
  assert.equal(isTerminalEvent(publish(stage({ type: "run_completed", status: "complete", result: "y" }))), true);
  assert.equal(isTerminalEvent(publish(stage({ type: "run_failed", error: { code: "auth", message: "no" } }))), true);
  assert.equal(isTerminalEvent(publish(stage({ type: "run_cancelled" }))), true);
  assert.equal(isTerminalEvent(publish(stage({ type: "text_delta", delta: "z" }))), false);
});

test("an SSE frame is one parsable data line", () => {
  const frame = sseFrame(publish(stage({ type: "text_delta", delta: "a\nb" })));
  assert.ok(frame.startsWith("data: "));
  assert.ok(frame.endsWith("\n\n"));
  const parsed = JSON.parse(frame.slice(6).trim());
  assert.equal(parsed.payload.delta, "a\nb", "newlines inside a token must not break the frame");
});
