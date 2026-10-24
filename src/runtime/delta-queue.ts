/**
 * A one-producer / one-consumer token queue.
 *
 * Why this exists: the Runtime is an async generator, and an async generator cannot
 * yield from inside a callback. The model adapter pushes deltas here while
 * `core.step` is still awaiting the decision; the generator drains the queue with
 * `Promise.race`-style interleaving. Without it, "streaming" would just batch every
 * token and flush them after the step finished -- theatre, not streaming.
 */

export type DeltaKind = "text" | "thinking";

export interface DeltaItem {
  kind: DeltaKind;
  delta: string;
}

export interface DeltaQueue {
  push(kind: DeltaKind, delta: string): void;
  close(): void;
  /** Resolves the next delta, or null once closed and drained. */
  next(): Promise<DeltaItem | null>;
}

export function createDeltaQueue(): DeltaQueue {
  const items: DeltaItem[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };

  return {
    push(kind, delta) {
      if (closed || delta.length === 0) return;
      items.push({ kind, delta });
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async next() {
      for (;;) {
        const head = items.shift();
        if (head) return head;
        if (closed) return null;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
