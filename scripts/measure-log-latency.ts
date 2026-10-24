import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublisher, stage } from "../src/runtime/events.ts";
import { createJsonlRunLog } from "../src/runtime/runlog.ts";

// Measure: what does awaiting one appendEvent actually cost?
const log = createJsonlRunLog(await mkdtemp(join(tmpdir(), "tinycode-lat-")));
const publish = createPublisher("latency-run");

const samples: number[] = [];
for (let i = 0; i < 500; i += 1) {
  const event = publish(stage({ type: "tool_started", toolCallId: "c" + i, toolName: "read_file" }));
  const t0 = performance.now();
  await log.appendEvent(event);
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const at = (p: number) => samples[Math.floor((samples.length - 1) * p)] ?? 0;
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
console.log("appends=500  mean=" + mean.toFixed(3) + "ms  p50=" + at(0.5).toFixed(3) + "ms  p95=" + at(0.95).toFixed(3) + "ms  max=" + at(1).toFixed(3) + "ms");
console.log("per-step cost with ~6 events/step:", (mean * 6).toFixed(2) + "ms");
console.log("reference: a local-model step takes 3000-70000ms; a cloud step ~1000ms");
