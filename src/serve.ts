import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";

import { createPiModelPort, createSandboxToolPort, resolveLocalModel, resolvePiModel } from "./adapters/pi.ts";
import type { Task } from "./core/types.ts";
import { createJsonlRunLog } from "./runtime/runlog.ts";
import { createRuntime } from "./runtime/run.ts";
import { SSE_HEADERS, isTerminalEvent, sseFrame } from "./runtime/stream-events.ts";

/**
 * SSE product surface. The event protocol is the SAME one the CLI consumes --
 * that is the point of having product-level events instead of SDK callbacks.
 *
 * A fresh Runtime is built per request because a Runtime is single-run by design
 * (its event sink is per-run). Sharing one across requests would interleave runs.
 */

type ResolvedModel = NonNullable<Awaited<ReturnType<typeof resolvePiModel>>>;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function serve(argv: string[], logDir: string): Promise<void> {
  const port = Number(flag(argv, "port") ?? 8787);
  const workspace = resolve(flag(argv, "workspace") ?? process.cwd());
  const check = flag(argv, "check") ?? "node --version";
  const endpoint = flag(argv, "endpoint");
  const wanted = flag(argv, "model");

  let resolved: ResolvedModel | null;
  if (endpoint) {
    if (!wanted) {
      console.error("serve --endpoint requires --model <modelId>");
      process.exitCode = 2;
      return;
    }
    resolved = await resolveLocalModel({ baseUrl: endpoint, modelId: wanted });
  } else {
    resolved = await resolvePiModel(wanted);
  }
  if (!resolved) {
    console.error("no model available: configure credentials or pass --endpoint");
    process.exitCode = 3;
    return;
  }
  const { models, model } = resolved;

  const attach = async (res: ServerResponse, request: string, signal: AbortSignal) => {
    res.writeHead(200, SSE_HEADERS);
    const runtime = createRuntime({
      model: createPiModelPort({ models, model }),
      tools: createSandboxToolPort({ root: workspace, checkCommand: check }),
      runLog: createJsonlRunLog(logDir),
    });
    const task: Task = { id: "http-" + Date.now(), request, workspace, checkCommand: check };
    try {
      for await (const event of runtime.run(task, { signal })) {
        res.write(sseFrame(event));
        if (isTerminalEvent(event)) break;
      }
    } catch (error) {
      res.write("data: " + JSON.stringify({ type: "end", displayLevel: "terminal", payload: { status: "error", message: String(error) } }) + "\n\n");
    } finally {
      res.end();
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, model: model.provider + "/" + model.id }));
      return;
    }
    if (url.pathname !== "/run") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "GET /run?request=... or GET /health" }));
      return;
    }
    const request = url.searchParams.get("request");
    if (!request) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing ?request=" }));
      return;
    }
    const controller = new AbortController();
    // Client disconnect must cancel the run, not leak it.
    req.on("close", () => controller.abort());
    void attach(res, request, controller.signal);
  });

  await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  console.log("tinycode sse on http://127.0.0.1:" + port);
  console.log("  GET /health");
  console.log("  GET /run?request=...   (text/event-stream)");
  console.log("model=" + model.provider + "/" + model.id + " workspace=" + workspace);
}
