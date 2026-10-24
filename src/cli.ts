import { resolve } from "node:path";

import { createMemoryTools, createScriptedModel } from "./adapters/fake.ts";
import {
  createPiModelPort,
  createSandboxToolPort,
  resolveLocalModel,
  resolvePiModel,
} from "./adapters/pi.ts";

/** Derived from the adapter's own signature: the product surface names no SDK type. */
type ResolvedModel = NonNullable<Awaited<ReturnType<typeof resolvePiModel>>>;
import type { Decision, ModelPort, Task, ToolPort } from "./core/types.ts";
import type { AgentEvent } from "./runtime/events.ts";
import { createJsonlRunLog, replayAgentState, terminalStatus } from "./runtime/runlog.ts";
import { createRuntime } from "./runtime/run.ts";
import { serve } from "./serve.ts";

/** Product surface. It consumes product-level events only -- never raw SDK callbacks. */

const LOG_DIR = resolve(process.cwd(), ".tinycode");

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 90 ? line.slice(0, 90) + "..." : line;
}

function describeDecision(decision: Decision): string {
  if (decision.kind === "call_tool") {
    return "call " + decision.intent.name + " " + JSON.stringify(decision.intent.arguments);
  }
  if (decision.kind === "respond") return "respond " + JSON.stringify(decision.content.slice(0, 90));
  return "ask_human " + JSON.stringify(decision.question);
}

function render(event: AgentEvent): string {
  const seq = String(event.sequence).padStart(3, "0");
  const head = "[" + seq + "] " + event.type.padEnd(22);
  switch (event.type) {
    case "decision_made":
      return head + describeDecision(event.decision);
    case "tool_started":
      return head + event.toolName;
    case "tool_completed":
      return head + event.toolName + " " + event.status + " (" + event.durationMs + "ms)";
    case "observation_added":
      return head + event.name + " " + (event.observation.ok ? "ok" : "FAILED") + ": " + firstLine(event.observation.summary);
    case "usage_reported": {
      const u = event.usage;
      return head + "tools=" + u.toolCalls + " in=" + (u.inputTokens ?? "n/a") + " out=" + (u.outputTokens ?? "n/a") + " " + u.durationMs + "ms";
    }
    case "run_completed":
      return head + event.status + (event.missingMaterial?.length ? " missing=" + JSON.stringify(event.missingMaterial) : "");
    case "compact_boundary":
      return head + "elided " + event.elided + " msg(s) -> " + event.estimatedTokens + " est. tokens";
    case "run_failed":
      return head + event.error.code + ": " + event.error.message;
    case "text_delta":
      return head + JSON.stringify(event.delta);
    case "thinking_delta":
      return head + JSON.stringify(event.delta);
    case "human_input_requested":
      return head + event.question;
    default:
      return head;
  }
}

async function printRun(
  runtime: ReturnType<typeof createRuntime>,
  task: Task,
  options: { signal?: AbortSignal; sessionId?: string; budget?: Record<string, number> } = {},
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let midLine = false;
  const endLine = () => {
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
  };

  for await (const event of runtime.run(task, options)) {
    events.push(event);
    // Token deltas are the typewriter: no sequence prefix, no newline.
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
      midLine = true;
      continue;
    }
    if (event.type === "thinking_delta") {
      process.stdout.write("\u001b[2m" + event.delta + "\u001b[22m");
      midLine = true;
      continue;
    }
    endLine();
    console.log(render(event));
  }
  endLine();
  return events;
}

const task: Task = {
  id: "demo-1",
  request: "Make greeting.txt contain exactly 'hello tinycode'",
  workspace: ".",
  checkCommand: "memory-check",
};

const happyScript: Decision[] = [
  { kind: "call_tool", toolCallId: "c1", intent: { name: "list_files", arguments: {} } },
  { kind: "call_tool", toolCallId: "c2", intent: { name: "read_file", arguments: { path: "greeting.txt" } } },
  { kind: "call_tool", toolCallId: "c3", intent: { name: "write_file", arguments: { path: "greeting.txt", content: "hello tinycode" } } },
  { kind: "call_tool", toolCallId: "c4", intent: { name: "run_check", arguments: {} } },
  { kind: "respond", content: "greeting.txt now contains hello tinycode and the check passes" },
];

function memoryCheck(files: Readonly<Record<string, string>>) {
  const actual = files["greeting.txt"];
  return { command: "memory-check", passed: actual === "hello tinycode", output: "greeting.txt=" + JSON.stringify(actual) };
}

function runtimeFor(model: ModelPort, tools: ToolPort, log = createJsonlRunLog(LOG_DIR)) {
  return createRuntime({ model, tools, runLog: log });
}

async function demo(): Promise<void> {
  const log = createJsonlRunLog(LOG_DIR);

  console.log("== 1. happy path: complete, with evidence on every event ==");
  const happy = await printRun(
    runtimeFor(createScriptedModel(happyScript), createMemoryTools({ files: { "greeting.txt": "old" }, check: memoryCheck }), log),
    task,
  );
  const runId = happy[0]?.runId ?? "";

  console.log("");
  console.log("== 2. refused tool: the run must be honestly partial ==");
  await printRun(
    runtimeFor(
      createScriptedModel([
        { kind: "call_tool", toolCallId: "c1", intent: { name: "delete_everything", arguments: { path: "/" } } },
        { kind: "respond", content: "I cannot do that with the tools I have" },
      ]),
      createMemoryTools({ files: {} }),
      log,
    ),
    { ...task, id: "demo-2" },
  );

  console.log("");
  console.log("== 3. user cancellation: no faked completion ==");
  const controller = new AbortController();
  let seen = 0;
  const cancelling = runtimeFor(
    createScriptedModel(happyScript),
    createMemoryTools({ files: { "greeting.txt": "old" }, check: memoryCheck }),
    log,
  );
  for await (const event of cancelling.run({ ...task, id: "demo-3" }, { signal: controller.signal })) {
    console.log(render(event));
    seen += 1;
    if (seen === 4) controller.abort();
  }

  console.log("");
  console.log("");
  console.log("== 4. context compaction: the transcript shrinks, the run survives ==");
  const readLoop: Decision[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    kind: "call_tool" as const,
    toolCallId: "c" + i,
    intent: { name: "read_file", arguments: { path: "big.txt" } },
  }));
  readLoop.push({ kind: "respond", content: "read it six times without blowing the context" });
  await printRun(
    createRuntime({
      model: createScriptedModel(readLoop),
      tools: createMemoryTools({ files: { "big.txt": "x".repeat(2000) } }),
      runLog: log,
      compaction: { compactAtTokens: 400, keepRecentMessages: 2 },
    }),
    { ...task, id: "demo-4", request: "Read big.txt six times, then summarise" },
    { budget: { maxToolCalls: 20 } },
  );

  console.log("");
  console.log("== 5. replay from the event log rebuilds the run ==");
  const stored = await log.listEvents(runId);
  const recovered = replayAgentState(task, stored);
  const again = replayAgentState(task, stored);
  console.log("run " + runId.slice(0, 8) + " -> " + stored.length + " events, status=" + terminalStatus(stored));
  console.log(
    "recovered: iteration=" + recovered.iteration +
      " observations=" + recovered.observations.length +
      " filesChanged=" + JSON.stringify(recovered.filesChanged) +
      " checkPassed=" + String(recovered.check?.passed),
  );
  console.log("idempotent replay: " + (JSON.stringify(recovered) === JSON.stringify(again)));
}

async function replay(runId: string): Promise<void> {
  const log = createJsonlRunLog(LOG_DIR);
  const events = await log.listEvents(runId);
  if (events.length === 0) {
    console.error("no events for run '" + runId + "' under " + LOG_DIR);
    process.exitCode = 2;
    return;
  }
  const replayedTask: Task = { id: "replayed", request: "(replayed)", workspace: ".", checkCommand: "(from log)" };
  for (const event of events) console.log(render(event));
  const recovered = replayAgentState(replayedTask, events);
  console.log("");
  console.log("status=" + terminalStatus(events) + " iteration=" + recovered.iteration + " observations=" + recovered.observations.length);
}
async function runReal(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf("--" + name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const request = flag("request");
  if (!request) {
    console.error(
      'usage: node src/cli.ts run --request "..." [--workspace dir] [--check cmd]' +
        " [--model provider/modelId | --endpoint <baseUrl> --model <modelId>] [--timeout ms]",
    );
    process.exitCode = 2;
    return;
  }

  const workspace = resolve(flag("workspace") ?? process.cwd());
  const check = flag("check") ?? "node --version";
  const wanted = flag("model");
  const endpoint = flag("endpoint");
  const timeoutMs = Number(flag("timeout") ?? 120_000);
  // "none" isolates transport from tool calling: useful against models that cannot
  // use tools, and the only way to verify usage reporting without one.
  const toolsDisabled = flag("tools") === "none";

  let resolved: ResolvedModel | null;
  if (endpoint) {
    // Keyless local endpoint path: a real network round-trip with no credentials.
    if (!wanted) {
      console.error("--endpoint requires --model <modelId>, e.g. --model deepseek-r1:7b");
      process.exitCode = 2;
      return;
    }
    resolved = await resolveLocalModel({ baseUrl: endpoint, modelId: wanted });
  } else {
    resolved = await resolvePiModel(wanted);
  }

  if (!resolved) {
    console.error("No provider credentials are configured, so there is no model to run.");
    console.error("Configure one (a provider API key or a pi login), then retry.");
    console.error("Or point at a local endpoint: --endpoint http://127.0.0.1:11434/v1 --model <id>");
    console.error("The fully verified path needs no credentials: node src/cli.ts demo");
    process.exitCode = 3;
    return;
  }
  const { models, model } = resolved;

  console.log(
    "model=" + model.provider + "/" + model.id +
      " workspace=" + workspace +
      " check=" + JSON.stringify(check) +
      " timeout=" + timeoutMs + "ms",
  );
  const port = createPiModelPort({ models, model, specs: toolsDisabled ? [] : undefined });
  if (toolsDisabled) console.log("tools=none (text-only run)");
  const runtime = createRuntime({
    model: port,
    tools: createSandboxToolPort({ root: workspace, checkCommand: check }),
    runLog: createJsonlRunLog(LOG_DIR),
    budget: { timeoutMs },
  });

  const events = await printRun(runtime, { id: "run-" + Date.now(), request, workspace, checkCommand: check });
  const last = events.at(-1);
  if (last?.type === "run_completed" && last.status === "partial") {
    console.error("");
    console.error("partial: " + JSON.stringify(last.missingMaterial));
    process.exitCode = 4;
  } else if (last?.type === "run_failed") {
    console.error("");
    console.error("failed(" + last.error.code + "): " + last.error.message);
    process.exitCode = 5;
  }
}

function help(): void {
  console.log("TinyCode -- a small coding agent with a separated Core and Runtime.");
  console.log("");
  console.log("  node src/cli.ts demo                offline: 4 deterministic scenarios + replay");
  console.log("  node src/cli.ts replay <runId>      rebuild a run from its event log");
  console.log('  node src/cli.ts run --request ".."    real model + real filesystem');
  console.log("         --endpoint <baseUrl> --model <id>   keyless local OpenAI-compatible endpoint");
  console.log("         --workspace <dir> --check <cmd> --timeout <ms> [--tools none]");
  console.log("         [--workspace dir] [--check \"cmd\"] [--model provider/modelId]");
  console.log("");
  console.log("Offline is the fully verified path; a live provider round-trip needs credentials.");
  console.log("logs: " + LOG_DIR);
}

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const rest = argv.slice(1);

if (command === "demo") await demo();
else if (command === "serve") await serve(rest, LOG_DIR);
else if (command === "replay" && rest[0]) await replay(rest[0]);
else if (command === "run") await runReal(rest);
else help();
