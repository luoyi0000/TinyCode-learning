import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createMemoryTools, createScriptedModel } from "../src/adapters/fake.ts";
import type { Decision, Task } from "../src/core/types.ts";
import { executeRun } from "../src/main/run-bridge.ts";
import { resolveWorkspace } from "../src/main/workspace.ts";
import type { AgentEvent } from "../src/runtime/events.ts";

/**
 * The Electron shell is split so its decisions live in electron-free modules.
 * That is what makes these tests possible without a window -- and a window is
 * exactly what this environment cannot provide.
 */

const task: Task = { id: "desk-1", request: "make a.txt say hi", workspace: ".", checkCommand: "true" };

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tinycode-desk-"));
}

// ---------------------------------------------------------------- workspace

test("an empty workspace lands in the userData sandbox, never the app dir", async () => {
  const userDataPath = await tmp();
  const appPath = await tmp();
  const chosen = resolveWorkspace("", { appPath, userDataPath });

  assert.equal(chosen, resolve(userDataPath, "workspace"));
  assert.ok((await stat(chosen)).isDirectory(), "the sandbox must be created");
  assert.equal(chosen.startsWith(appPath), false);
});

test("a workspace inside the application directory is refused", async () => {
  const appPath = await tmp();
  const userDataPath = await tmp();

  // The agent must not be able to edit its own source: that is a behaviour change.
  assert.throws(
    () => resolveWorkspace(join(appPath, "src"), { appPath, userDataPath }),
    /must not edit its own source/,
  );
  assert.throws(() => resolveWorkspace(appPath, { appPath, userDataPath }), /application directory/);
});

test("an explicit workspace outside the app is accepted and created", async () => {
  const appPath = await tmp();
  const userDataPath = await tmp();
  const chosen = resolveWorkspace(join(userDataPath, "elsewhere"), { appPath, userDataPath });
  assert.ok((await stat(chosen)).isDirectory());
});

// ---------------------------------------------------------------- run bridge

const script: Decision[] = [
  { kind: "call_tool", toolCallId: "c1", intent: { name: "read_file", arguments: { path: "a.txt" } } },
  { kind: "respond", content: "read it" },
];

test("every product event reaches the renderer, in order, ending in a terminal", async () => {
  const sent: AgentEvent[] = [];
  await executeRun({
    modelPort: createScriptedModel(script),
    toolPort: createMemoryTools({ files: { "a.txt": "hi" } }),
    task,
    logDir: await tmp(),
    send: (event) => sent.push(event),
    signal: new AbortController().signal,
  });

  assert.ok(sent.length > 0, "the renderer must receive events");
  assert.equal(sent[0]?.type, "run_started");
  sent.forEach((event, index) => assert.equal(event.sequence, index + 1));
  assert.ok(sent.some((event) => event.type === "tool_completed"));
  assert.ok(sent.some((event) => event.type === "usage_reported"));
  assert.equal(sent.at(-1)?.type, "run_completed");
});

test("a cancelled run is reported as cancelled, not as a completion", async () => {
  const sent: AgentEvent[] = [];
  const controller = new AbortController();
  await executeRun({
    modelPort: createScriptedModel(script),
    toolPort: createMemoryTools({ files: { "a.txt": "hi" } }),
    task,
    logDir: await tmp(),
    send: (event) => { sent.push(event); if (event.type === "run_started") controller.abort(); },
    signal: controller.signal,
  });

  assert.equal(sent.at(-1)?.type, "run_cancelled");
  assert.equal(sent.some((event) => event.type === "run_completed"), false);
});

test("a runtime that cannot start still sends a terminal event to the renderer", async () => {
  // A log path that cannot be created forces the run to throw before it can emit
  // anything of its own. The bridge must still terminate the UI.
  const bogus = join(await tmp(), "file");
  await writeFile(bogus, "x", "utf8");
  const sent: AgentEvent[] = [];

  await executeRun({
    modelPort: createScriptedModel(script),
    toolPort: createMemoryTools({ files: {} }),
    task,
    logDir: join(bogus, "sub"),
    send: (event) => sent.push(event),
    signal: new AbortController().signal,
  });

  const last = sent.at(-1);
  assert.ok(last, "the renderer must not be left hanging");
  assert.equal(last.type, "run_failed");
});

