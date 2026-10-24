import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentEvent } from "../src/runtime/events.ts";
import { createJsonlRunLog, replayAgentState, terminalStatus } from "../src/runtime/runlog.ts";

/**
 * Adopt a REAL run into the golden transcript set.
 *
 * The skill asks for golden runs "captured from real runs", not hand-written ones.
 * A live transcript is pinned here once, then replayed deterministically by
 * test/transcripts.test.ts forever after -- so a later SDK or Core change that
 * alters semantics fails a test instead of drifting quietly.
 *
 * usage: node scripts/adopt-transcript.ts <runId> <label>
 */

const LOG_DIR = resolve(process.cwd(), ".tinycode");
const OUT = resolve(process.cwd(), "transcripts");

interface GoldenEntry {
  file: string;
  logFile: string;
  task: { id: string; request: string; workspace: string; checkCommand: string };
  events: number;
  terminal: string;
  observations: Array<{ name: string; ok: boolean }>;
  filesChanged: string[];
  checkPassed: boolean | null;
  missingMaterial: string[];
  source: string;
}

const runId = process.argv[2];
const label = process.argv[3];
if (!runId || !label) {
  console.error("usage: node scripts/adopt-transcript.ts <runId> <label>");
  process.exit(2);
}

const log = createJsonlRunLog(LOG_DIR);
const run = await log.loadRun(runId);
if (!run) {
  console.error("no run record for " + runId + " under " + LOG_DIR);
  process.exit(2);
}
if (!run.task) {
  console.error("run " + runId + " predates task persistence; re-record it");
  process.exit(2);
}

const events = await log.listEvents(runId);
const recovered = replayAgentState(run.task, events);

await copyFile(
  resolve(LOG_DIR, "events", runId + ".jsonl"),
  resolve(OUT, "events", runId + ".jsonl"),
);

const manifestPath = resolve(OUT, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GoldenEntry[];

const entry: GoldenEntry = {
  file: label,
  logFile: "events/" + runId + ".jsonl",
  task: run.task,
  events: events.length,
  terminal: terminalStatus(events),
  observations: recovered.observations.map((o) => ({ name: o.name, ok: o.ok })),
  filesChanged: recovered.filesChanged,
  checkPassed: recovered.check?.passed ?? null,
  missingMaterial: recovered.missingMaterial,
  source: "live run " + runId + " (workspace " + run.task.workspace + ")",
};

const next = manifest.filter((m) => m.file !== label).concat(entry);
await writeFile(manifestPath, JSON.stringify(next, null, 2) + "\n", "utf8");

console.log("adopted " + label + ": " + events.length + " events -> " + entry.terminal);
console.log("  observations: " + JSON.stringify(entry.observations));
console.log("  filesChanged: " + JSON.stringify(entry.filesChanged));
console.log("  checkPassed: " + String(entry.checkPassed));
console.log("  missingMaterial: " + JSON.stringify(entry.missingMaterial));
