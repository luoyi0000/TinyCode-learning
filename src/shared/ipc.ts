import type { AgentEvent } from "../runtime/events.ts";

/**
 * The IPC contract, shared by main, preload and renderer.
 *
 * Named channels only -- the preload never exposes ipcRenderer itself, so the
 * renderer cannot address an arbitrary channel (electron security checklist:
 * "Preload never exposes raw ipcRenderer" / "Every exposed function targets a
 * specific, named IPC channel").
 */

export const CHANNEL_RUN_START = "tinycode:run:start";
export const CHANNEL_RUN_CANCEL = "tinycode:run:cancel";
export const CHANNEL_RUN_EVENT = "tinycode:run:event";

export interface RunRequest {
  request: string;
  workspace: string;
  checkCommand: string;
  /** OpenAI-compatible endpoint. When absent, cloud provider credentials are used. */
  endpoint?: string;
  modelId?: string;
}

export interface RunStartResult {
  ok: boolean;
  runId?: string;
  message?: string;
}

/** What the renderer receives: product-level events, never raw SDK callbacks. */
export type RunEventMessage = AgentEvent;
