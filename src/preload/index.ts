import { contextBridge, ipcRenderer } from "electron";

import {
  CHANNEL_RUN_CANCEL,
  CHANNEL_RUN_EVENT,
  CHANNEL_RUN_START,
  type RunEventMessage,
  type RunRequest,
  type RunStartResult,
} from "../shared/ipc.ts";

/**
 * The only surface the renderer may touch.
 *
 * Deliberately: no raw ipcRenderer, no dynamic channel names, no node modules.
 * Every function targets one named channel, and the event listener returns its
 * own unsubscribe so React effects can clean up.
 */
const api = {
  run: (request: RunRequest): Promise<RunStartResult> => ipcRenderer.invoke(CHANNEL_RUN_START, request),
  cancel: (): Promise<boolean> => ipcRenderer.invoke(CHANNEL_RUN_CANCEL),
  onEvent: (listener: (event: RunEventMessage) => void): (() => void) => {
    const handler = (_event: unknown, payload: RunEventMessage) => listener(payload);
    ipcRenderer.on(CHANNEL_RUN_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(CHANNEL_RUN_EVENT, handler);
    };
  },
};

contextBridge.exposeInMainWorld("tinycode", api);

export type TinyCodeApi = typeof api;
