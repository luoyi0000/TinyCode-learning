import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { WebContents } from "electron";
import { app, ipcMain } from "electron";

import { createPiModelPort, createSandboxToolPort, resolveLocalModel, resolvePiModel } from "../../adapters/pi.ts";
import type { Task } from "../../core/types.ts";
import { createRuntime } from "../../runtime/run.ts";
import { createJsonlRunLog } from "../../runtime/runlog.ts";
import { CHANNEL_RUN_CANCEL, CHANNEL_RUN_EVENT, CHANNEL_RUN_START, type RunRequest, type RunStartResult } from "../../shared/ipc.ts";

/**
 * Runtime hosting lives in the MAIN process: the Pi Agent SDK is a Node package and
 * must never reach the renderer. The renderer only sees product-level events.
 */

let active: AbortController | null = null;

/**
 * Where the agent is allowed to work.
 *
 * Two guards, both structural rather than prompt-based:
 *   1. Empty means a dedicated sandbox under userData -- never the app directory.
 *   2. A path inside the application directory is refused outright, because a coding
 *      agent that can edit its own source can change its own behaviour.
 */
function resolveWorkspace(requested: string): string {
  if (!requested.trim()) {
    const fallback = resolve(app.getPath("userData"), "workspace");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  const appPath = resolve(app.getAppPath());
  const absolute = resolve(requested);
  if (absolute === appPath || absolute.startsWith(appPath + sep)) {
    throw new Error(
      "workspace refuses to point inside the application directory: the agent must not edit its own source",
    );
  }
  mkdirSync(absolute, { recursive: true });
  return absolute;
}

export function registerRunHandlers(sender: () => WebContents, logDir: string): void {
  ipcMain.removeHandler(CHANNEL_RUN_START);
  ipcMain.removeHandler(CHANNEL_RUN_CANCEL);

  ipcMain.handle(CHANNEL_RUN_START, async (_event, request: RunRequest): Promise<RunStartResult> => {
    if (active) return { ok: false, message: "a run is already in progress" };
    if (!request?.request?.trim()) return { ok: false, message: "request is empty" };

    let workspace: string;
    try {
      workspace = resolveWorkspace(request.workspace);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    // Model resolution lives in the adapter, not here: the SDK is imported by exactly
    // one file, and that invariant is enforced by a test.
    const resolved = request.endpoint
      ? await resolveLocalModel({ baseUrl: request.endpoint, modelId: request.modelId ?? "" })
      : await resolvePiModel(request.modelId);
    if (!resolved) {
      return { ok: false, message: "no model available: pass an endpoint or configure provider credentials" };
    }

    const controller = new AbortController();
    active = controller;
    const runId = "desktop-" + Date.now();
    const task: Task = {
      id: runId,
      request: request.request,
      workspace,
      checkCommand: request.checkCommand,
    };

    const runtime = createRuntime({
      model: createPiModelPort({ models: resolved.models, model: resolved.model }),
      tools: createSandboxToolPort({ root: request.workspace, checkCommand: request.checkCommand }),
      runLog: createJsonlRunLog(logDir),
    });

    // Fire and forget: the run reports progress by pushing events to the renderer.
    void (async () => {
      const webContents = sender();
      const send = (event: unknown) => {
        if (!webContents.isDestroyed()) webContents.send(CHANNEL_RUN_EVENT, event);
      };
      try {
        for await (const event of runtime.run(task, { signal: controller.signal })) send(event);
      } catch (error) {
        send({
          type: "run_failed",
          runId,
          sequence: -1,
          timestamp: Date.now(),
          error: { code: "runtime_error", message: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        active = null;
      }
    })();

    return { ok: true, runId };
  });

  ipcMain.handle(CHANNEL_RUN_CANCEL, async (): Promise<boolean> => {
    if (!active) return false;
    active.abort();
    return true;
  });
}
