import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createMemoryTools, createScriptedModel } from "../src/adapters/fake.ts";
import type { Decision, Task } from "../src/core/types.ts";
import { createJsonlRunLog, replayAgentState, terminalStatus } from "../src/runtime/runlog.ts";
import { createRuntime } from "../src/runtime/run.ts";

/**
 * Records golden transcripts: real event logs, pinned to disk, replayed by
 * test/transcripts.test.ts so an SDK upgrade cannot silently change semantics.
 */

const OUT = resolve(process.cwd(), "transcripts");

const task: Task = {
  id: "golden-happy",
  request: "Make greeting.txt contain exactly 'hello tinycode'",
  workspace: ".",
  checkCommand: "memory-check",
};

const happy: Decision[] = [
  { kind: "call_tool", toolCallId: "c1", intent: { name: "list_files", arguments: {} } },
  { kind: "call_tool", toolCallId: "c2", intent: { name: "read_file", arguments: { path: "greeting.txt" } } },
  { kind: "call_tool", toolCallId: "c3", intent: { name: "write_file", arguments: { path: "greeting.txt", content: "hello tinycode" } } },
  { kind: "call_tool", toolCallId: "c4", intent: { name: "run_check", arguments: {} } },
  { kind: "respond", content: "greeting.txt updated, check passes" },
];

const check = (f: Readonly<Record<string, string>>) => ({
  command: "memory-check",
  passed: f["greeting.txt"] === "hello tinycode",
  output: "greeting.txt=" + JSON.stringify(f["greeting.txt"]),
});

interface Scenario {
  file: string;
  task: Task;
  script: Decision[];
  files: Record<string, string>;
}

const scenarios: Scenario[] = [
  { file: "happy", task, script: happy, files: { "greeting.txt": "old" } },
  {
    file: "refused-tool",
    task: { ...task, id: "golden-refused" },
    script: [
      { kind: "call_tool", toolCallId: "c1", intent: { name: "delete_everything", arguments: { path: "/" } } },
      { kind: "respond", content: "I cannot do that with the tools I have" },
    ],
    files: {},
  },
  {
    file: "failed-check",
    task: { ...task, id: "golden-failed-check", checkCommand: "memory-check-strict" },
    script: [
      { kind: "call_tool", toolCallId: "c1", intent: { name: "run_check", arguments: {} } },
      { kind: "respond", content: "the check is red and I could not fix it" },
    ],
    files: { "greeting.txt": "still-old" },
  },
];

const manifest = [];
for (const scenario of scenarios) {
  const log = createJsonlRunLog(OUT);
  const runtime = createRuntime({
    model: createScriptedModel(scenario.script),
    tools: createMemoryTools({ files: { ...scenario.files }, check }),
    runLog: log,
  });
  let runId = "";
  for await (const event of runtime.run(scenario.task)) {
    if (!runId) runId = event.runId;
  }
  const events = await log.listEvents(runId);
  const recovered = replayAgentState(scenario.task, events);
  manifest.push({
    file: scenario.file,
    logFile: "events/" + runId + ".jsonl",
    task: scenario.task,
    events: events.length,
    terminal: terminalStatus(events),
    observations: recovered.observations.map((o) => ({ name: o.name, ok: o.ok })),
    filesChanged: recovered.filesChanged,
    checkPassed: recovered.check?.passed ?? null,
    missingMaterial: recovered.missingMaterial,
  });
  console.log(scenario.file + ": " + events.length + " events -> " + terminalStatus(events));
}

await writeFile(resolve(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("manifest written: " + manifest.length + " golden transcripts");
