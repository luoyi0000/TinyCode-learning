import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPiModelPort, resolveLocalModel } from "../src/adapters/pi.ts";
import type { Task } from "../src/core/types.ts";
import type { AgentEvent } from "../src/runtime/events.ts";
import { createJsonlRunLog, terminalStatus } from "../src/runtime/runlog.ts";
import { createRuntime } from "../src/runtime/run.ts";

/**
 * Provider failure classification, exercised through a real HTTP endpoint.
 *
 * These two codes were the only ones whose behaviour had never been triggered by a
 * real server: 402 came from the skill's verification log, model_capability from a
 * live ollama run. A regex unit test proves the regex; only a real socket proves the
 * whole path (SDK throw -> adapter mapping -> Runtime terminal event).
 */

interface Mock { baseUrl: string; requests: () => number; close: () => Promise<void> }

async function mockProvider(status: number, body: unknown): Promise<Mock> {
  let requests = 0;
  const server = createServer((req, res) => {
    let payload = "";
    req.on("data", (chunk) => { payload += chunk; });
    req.on("end", () => {
      if (req.url && req.url.includes("chat/completions")) requests += 1;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    requests: () => requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

const task: Task = { id: "billing", request: "do something", workspace: ".", checkCommand: "true" };

async function runAgainst(mock: Mock, maxRetries: number) {
  const { models, model } = await resolveLocalModel({ baseUrl: mock.baseUrl, modelId: "mock-model" });
  const log = createJsonlRunLog(await mkdtemp(join(tmpdir(), "tinycode-billing-")));
  const runtime = createRuntime({
    model: createPiModelPort({ models, model }),
    tools: { execute: async () => { throw new Error("no tool should run"); } },
    runLog: log,
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.run(task, { budget: { maxRetries, timeoutMs: 10_000 } })) events.push(event);
  return { events, log };
}

test("HTTP 402 Insufficient Balance fails typed and is never retried", async () => {
  const mock = await mockProvider(402, {
    error: { message: "Insufficient Balance", type: "invalid_request_error", code: "402" },
  });
  try {
    const { events, log } = await runAgainst(mock, 3);

    const last = events.at(-1);
    assert.equal(last?.type, "run_failed");
    assert.equal(last?.type === "run_failed" ? last.error.code : null, "provider_unavailable");
    assert.equal(mock.requests(), 1, "a balance failure must not be retried");
    assert.equal(events.some((e) => e.type === "run_completed"), false);
    assert.equal(terminalStatus(await log.listEvents(events[0]?.runId ?? "")), "failed");
    events.forEach((event, index) => assert.equal(event.sequence, index + 1));
    assert.ok(events.some((e) => e.type === "usage_reported"), "a failed run still reports cost");
  } finally {
    await mock.close();
  }
});

test("a capability mismatch is typed as model_capability, not provider_unavailable", async () => {
  // Real ollama answered exactly this, verbatim, for deepseek-r1:7b with tools:
  //   400: {"message":"registry.ollama.ai/library/deepseek-r1:7b does not support tools",
  //         "type":"invalid_request_error","param":null,"code":null}
  // The SDK surfaces that body in the thrown message, which is why the mapping works.
  const mock = await mockProvider(400, {
    error: { message: "registry.ollama.ai/library/deepseek-r1:7b does not support tools", type: "invalid_request_error" },
  });
  try {
    const { events } = await runAgainst(mock, 3);
    const last = events.at(-1);
    assert.equal(last?.type, "run_failed");
    assert.equal(last?.type === "run_failed" ? last.error.code : null, "model_capability");
    assert.equal(mock.requests(), 1, "a capability mismatch must not be retried");
  } finally {
    await mock.close();
  }
});

test("documented limitation: a flat error body loses its detail before the adapter sees it", async () => {
  // Verified fact about the SDK: an error body shaped {message,type} (no `error` wrapper)
  // is dropped -- the thrown message becomes just "400 status code (no body)".
  // The run still fails safely and is still not retried, but the code degrades to
  // provider_unavailable because the adapter only ever sees the message text.
  // No real provider in this project returns that shape; recorded so nobody
  // mistakes it for a regression, and so an SDK upgrade that fixes it is noticed.
  const mock = await mockProvider(400, { message: "does not support tools", type: "invalid_request_error" });
  try {
    const { events } = await runAgainst(mock, 3);
    const last = events.at(-1);
    assert.equal(last?.type, "run_failed");
    assert.equal(last?.type === "run_failed" ? last.error.code : null, "provider_unavailable");
    assert.match(last?.type === "run_failed" ? last.error.message : "", /no body/);
  } finally {
    await mock.close();
  }
});
