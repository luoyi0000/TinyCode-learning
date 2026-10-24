import type { RunEventMessage, RunRequest, RunStartResult } from "../shared/ipc.ts";

declare global {
  interface Window {
    tinycode: {
      run(request: RunRequest): Promise<RunStartResult>;
      cancel(): Promise<boolean>;
      onEvent(listener: (event: RunEventMessage) => void): () => void;
    };
  }
}

export {};
