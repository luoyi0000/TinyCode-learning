import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Task } from "../src/core/types.ts";
import type { AgentEvent } from "../src/runtime/events.ts";
import { replayAgentState, terminalStatus } from "../src/runtime/runlog.ts";

/**
 * Golden transcripts: pinned, real event logs replayed deterministically.
 * If a Core or adapter change alters semantics, these fail instead of drifting quietly.
 */

interface GoldenEntry {
  file: string;
  logFile: string;
  task: Task;
  events: number;
  terminal: string;
  observations: Array<{ name: string; ok: boolean }>;
  filesChanged: string[];
  checkPassed: boolean | null;
  missingMaterial: string[];
}

const dir = resolve(process.cwd(), "transcripts");
const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")) as GoldenEntry[];

test("the golden manifest is not empty", () => {
  assert.ok(manifest.length >= 3, "expected at least three pinned transcripts");
});

for (const entry of manifest) {
  test("golden replay: " + entry.file, async () => {
    const raw = await readFile(resolve(dir, entry.logFile), "utf8");
    const events = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AgentEvent);

    assert.equal(events.length, entry.events, "the pinned log must not change shape");
    assert.equal(terminalStatus(events), entry.terminal);

    const recovered = replayAgentState(entry.task, events);
    assert.deepEqual(
      recovered.observations.map((o) => ({ name: o.name, ok: o.ok })),
      entry.observations,
    );
    assert.deepEqual(recovered.filesChanged, entry.filesChanged);
    assert.equal(recovered.check?.passed ?? null, entry.checkPassed);
    assert.deepEqual(recovered.missingMaterial, entry.missingMaterial);

    // Replay is idempotent: the same log applied twice yields the same state.
    assert.deepEqual(replayAgentState(entry.task, events), recovered);

    // Sequence is monotonic from 1 and the last event is terminal.
    events.forEach((event, index) => assert.equal(event.sequence, index + 1));
  });
}
