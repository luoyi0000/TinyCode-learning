import { PortError, type Decision, type ModelPort, type Observation, type ToolPort } from "../core/types.ts";
import { stringArg, truncate } from "../core/policy.ts";
import type { CheckOutcome } from "../core/types.ts";

/**
 * Deterministic adapters. They implement exactly the same port contracts as the
 * real ones, which is what makes "fake and real produce the same Core semantics"
 * a testable claim rather than a slogan.
 */

export interface ScriptedModel extends ModelPort {
  readonly decisionsServed: number;
}

export function createScriptedModel(decisions: readonly Decision[]): ScriptedModel {
  let index = 0;
  return {
    get decisionsServed() {
      return index;
    },
    async decide(): Promise<Decision> {
      const next = decisions[index];
      if (!next) {
        throw new PortError("runtime_error", "scripted model ran out of decisions after " + index);
      }
      index += 1;
      return next;
    },
  };
}

export interface MemoryToolsOptions {
  files?: Record<string, string>;
  /** Pure check function so tests never spawn a process. */
  check?: (files: Readonly<Record<string, string>>) => CheckOutcome;
}

export interface MemoryToolPort extends ToolPort {
  readonly files: Record<string, string>;
}

export function createMemoryTools(options: MemoryToolsOptions = {}): MemoryToolPort {
  const files: Record<string, string> = { ...(options.files ?? {}) };
  const check =
    options.check ?? ((current: Readonly<Record<string, string>>) => {
      void current;
      return { command: "memory", passed: true, output: "ok" };
    });

  return {
    files,
    async execute(toolCallId, intent, signal): Promise<Observation> {
      signal.throwIfAborted();
      const observedAt = Date.now();
      const base = { toolCallId, name: intent.name, observedAt };

      switch (intent.name) {
        case "list_files": {
          const dir = stringArg(intent, "dir") ?? ".";
          const prefix = dir === "." ? "" : dir.replace(/\/$/, "") + "/";
          const names = Object.keys(files)
            .filter((path) => path.startsWith(prefix))
            .map((path) => path.slice(prefix.length))
            .sort();
          return { ...base, ok: true, summary: names.join("\n"), data: names };
        }
        case "read_file": {
          const path = stringArg(intent, "path");
          if (!path) throw new PortError("invalid_tool", "read_file requires 'path'");
          const content = files[path];
          if (content === undefined) {
            return { ...base, ok: false, summary: "not found: " + path, data: null };
          }
          return { ...base, ok: true, summary: truncate(content), data: content };
        }
        case "write_file": {
          const path = stringArg(intent, "path");
          const content = stringArg(intent, "content");
          if (!path || content === undefined) {
            throw new PortError("invalid_tool", "write_file requires 'path' and 'content'");
          }
          files[path] = content;
          return { ...base, ok: true, summary: "wrote " + content.length + " chars to " + path, data: null };
        }
        case "run_check": {
          const outcome = check(files);
          return {
            ...base,
            ok: true,
            summary: (outcome.passed ? "check passed: " : "check failed: ") + truncate(outcome.output, 400),
            data: outcome,
          };
        }
        default:
          throw new PortError("invalid_tool", "unknown tool: " + intent.name);
      }
    },
  };
}
