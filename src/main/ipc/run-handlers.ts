import type { WebContents } from "electron";
import { app, ipcMain } from "electron";

import {
  createPiModelPort,
  createSandboxToolPort,
  resolveLocalModel,
  resolvePiModel,
} from "../../adapters/pi.ts";
import type { Task } from "../../core/types.ts";
import {
  CHANNEL_RUN_CANCEL,
  CHANNEL_RUN_EVENT,
  CHANNEL_RUN_START,
  type RunRequest,
  type RunStartResult,
} from "../../shared/ipc.ts";
import { executeRun } from "../run-bridge.ts";
import { resolveWorkspace } from "../workspace.ts";

/**
 * The IPC shell. Every decision lives in an electron-free module (run-bridge,
 * workspace) so it is testable in plain Node; this file only wires IPC, model
 * resolution and the sender.
 */

let active: AbortController | null = null;

export function registerRunHandlers(sender: () => WebContents, logDir: string): void {
  ipcMain.removeHandler(CHANNEL_RUN_START);
  ipcMain.removeHandler(CHANNEL_RUN_CANCEL);

  ipcMain.handle(CHANNEL_RUN_START, async (_event, request: RunRequest): Promise<RunStartResult> => {
    if (active) return { ok: false, message: "a run is already in progress" };
    if (!request?.request?.trim()) return { ok: false, message: "request is empty" };

    let workspace: string;
    try {
      workspace = resolveWorkspace(request.workspace ?? "", {
        appPath: app.getAppPath(),
        userDataPath: app.getPath("userData"),
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    let resolved: Awaited<ReturnType<typeof resolvePiModel>>;
    try {
      // Model resolution lives in the adapter, never here: the SDK is imported by
      // exactly one file, and a test enforces that.
      resolved = request.endpoint
        ? await resolveLocalModel({ baseUrl: request.endpoint, modelId: request.modelId ?? "" })
        : await resolvePiModel(request.modelId);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!resolved) {
      return {
        ok: false,
        message: "no model available: pass an endpoint or configure provider credentials",
      };
    }

    const controller = new AbortController();
    active = controller;
    const runId = "desktop-" + Date.now();
    const task: Task = {
      id: runId,
      request: request.request,
      workspace,
      checkCommand: request.checkCommand?.trim() || "node --version",
    };

    void executeRun({
      modelPort: createPiModelPort({ models: resolved.models, model: resolved.model }),
      toolPort: createSandboxToolPort({ root: workspace, checkCommand: task.checkCommand }),
      task,
      logDir,
      signal: controller.signal,
      send: (event) => {
        const webContents = sender();
        if (!webContents.isDestroyed()) webContents.send(CHANNEL_RUN_EVENT, event);
      },
    }).finally(() => {
      active = null;
    });

    return { ok: true, runId };
  });

  ipcMain.handle(CHANNEL_RUN_CANCEL, async (): Promise<boolean> => {
    if (!active) return false;
    active.abort();
    return true;
  });
}
