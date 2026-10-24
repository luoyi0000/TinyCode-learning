import type { RunBudget } from "../core/types.ts";

export const DEFAULT_BUDGET: RunBudget = {
  maxIterations: 8,
  maxToolCalls: 6,
  maxRetries: 2,
  timeoutMs: 60_000,
};

export type AbortReason = "user" | "timeout" | null;

export interface RuntimeSignal {
  readonly signal: AbortSignal;
  /** Why the run was aborted. Distinguishes a user cancel from a budget timeout. */
  reason(): AbortReason;
  dispose(): void;
}

/**
 * The Runtime always owns a signal: the caller's signal composed with the budget
 * timeout. Adapters receive it as a required argument, never as an option.
 */
export function composeSignal(timeoutMs: number, external?: AbortSignal): RuntimeSignal {
  const controller = new AbortController();
  let reason: AbortReason = null;

  const onExternalAbort = () => {
    reason ??= "user";
    controller.abort(external?.reason);
  };

  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      reason ??= "timeout";
      controller.abort(new Error("budget_timeout"));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    reason: () => reason,
    dispose() {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}
