import type { ChatMessage } from "./types.ts";

/**
 * Context budgeting: estimating size, and compacting deterministically.
 *
 * Two hard rules shape this file:
 *   1. No model call. Compaction must be reproducible, and a summarisation model
 *      call would make replay non-deterministic and cost money mid-run.
 *   2. Elision must be LOUD. Dropped history is replaced by a boundary message that
 *      names exactly what was dropped, so the model knows it forgot something and
 *      can re-read a file instead of hallucinating its contents.
 */

/**
 * Rough size estimate in tokens.
 *
 * A real tokenizer is provider-specific and would drag the SDK into the Core. This is
 * a deliberate 4-chars-per-token heuristic: it is used ONLY for budgeting decisions,
 * never for billing. Documented as an estimate wherever it is surfaced.
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += 4; // per-message envelope overhead
    if (message.role === "user") total += Math.ceil(message.text.length / 4);
    else if (message.role === "tool") total += Math.ceil(message.text.length / 4) + 4;
    else {
      total += Math.ceil(message.text.length / 4);
      for (const call of message.toolCalls) {
        total += 4 + Math.ceil((call.name.length + JSON.stringify(call.arguments).length) / 4);
      }
    }
  }
  return total;
}

export interface CompactionResult {
  messages: ChatMessage[];
  elided: number;
}

const BOUNDARY_PREFIX = "[context compacted]";

/**
 * Keep the head (task request) and the most recent turns; replace the middle with one
 * boundary message. Deterministic: same input + same policy => same output, which is
 * what lets event-log replay reproduce a compacted run exactly.
 *
 * Never compacts below the first user message: the task itself is not negotiable.
 */
export function compactContext(
  messages: readonly ChatMessage[],
  keepRecentMessages: number,
): CompactionResult {
  const firstUser = messages.findIndex((m) => m.role === "user");
  let headEnd = firstUser >= 0 ? firstUser + 1 : 0;

  // Preserve an existing boundary: it is already a summary of everything before it.
  // Without this, compacting twice would keep re-eliding and rewording the boundary,
  // which is churn and breaks idempotency (and therefore replay equality).
  if (headEnd < messages.length && isBoundaryMessage(messages[headEnd] as ChatMessage)) headEnd += 1;

  const head = messages.slice(0, headEnd);
  const rest = messages.slice(headEnd);
  const keepFrom = Math.max(0, rest.length - Math.max(0, keepRecentMessages));

  if (keepFrom === 0) return { messages: [...messages], elided: 0 };

  // Do not split a tool call from its result: start the kept window at a user or
  // assistant message so a toolResult never arrives without its call.
  let start = keepFrom;
  while (start < rest.length && rest[start]?.role === "tool") start += 1;
  if (start >= rest.length) start = keepFrom;

  const elidedMessages = rest.slice(0, start);
  if (elidedMessages.length === 0) return { messages: [...messages], elided: 0 };

  const names = elidedMessages
    .filter((m) => m.role === "tool")
    .map((m) => (m.role === "tool" ? m.name : ""))
    .filter((n) => n.length > 0);

  const boundary: ChatMessage = {
    role: "user",
    text:
      BOUNDARY_PREFIX +
      " " + elidedMessages.length + " earlier message(s) were dropped to stay inside the context budget." +
      (names.length > 0 ? " Dropped tool results: " + [...new Set(names)].join(", ") + "." : "") +
      " Re-read files if you need their contents again rather than assuming them.",
  };

  return { messages: [...head, boundary, ...rest.slice(start)], elided: elidedMessages.length };
}

export function isBoundaryMessage(message: ChatMessage): boolean {
  return message.role === "user" && message.text.startsWith(BOUNDARY_PREFIX);
}
