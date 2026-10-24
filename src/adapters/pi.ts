import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

// `@earendil-works/pi-ai` is ESM-only, and this file is loaded inside the Electron
// main process, which must be a CJS bundle. A CJS require() of an ESM-only package
// fails with ERR_PACKAGE_PATH_NOT_EXPORTED, so this import is TYPES ONLY and every
// runtime access goes through dynamic import() (which bridges CJS -> ESM).
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Models,
  Tool as PiTool,
  ToolCall,
} from "@earendil-works/pi-ai";

import { TOOL_SPECS, stringArg, truncate, type ToolSpec } from "../core/policy.ts";
import {
  PortError,
  type ChatMessage,
  type CheckOutcome,
  type Decision,
  type ModelPort,
  type ModelProgress,
  type ModelUsage,
  type Observation,
  type ToolPort,
} from "../core/types.ts";

/**
 * The only file allowed to import the Pi Agent SDK.
 * Every mapping decision here is justified in docs/adapter-mapping.md.
 */

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

export function toPiTool(spec: ToolSpec): PiTool {
  return {
    name: spec.name,
    description: spec.description,
    // Type.Unsafe(schema) is the identity for an already-valid JSON Schema; using the
    // cast instead keeps this file free of a runtime SDK import.
    parameters: spec.parameters as unknown as PiTool["parameters"],
  };
}

function isToolCall(block: { type: string }): block is ToolCall {
  return block.type === "toolCall";
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * The Core's transcript is provider-neutral. pi-ai's AssistantMessage is a
 * provider *response* shape, so replaying our own turns means materializing the
 * envelope fields. Usage stays zeroed on purpose: prior turns were already
 * reported by the Runtime when they happened, and inventing numbers would be a lie.
 */
function toPiMessages(messages: readonly ChatMessage[], model: Model<Api>): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.text, timestamp: Date.now() });
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: [{ type: "text", text: message.text }],
        isError: !message.ok,
        timestamp: Date.now(),
      });
      continue;
    }
    const content: AssistantMessage["content"] = [];
    if (message.text) content.push({ type: "text", text: message.text });
    for (const call of message.toolCalls) {
      content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
    }
    out.push({
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...ZERO_USAGE },
      stopReason: message.toolCalls.length > 0 ? "toolUse" : "stop",
      timestamp: Date.now(),
    });
  }
  return out;
}

export function mapProviderError(errorMessage: string | undefined): PortError {
  const text = (errorMessage ?? "provider error").trim();
  // A capability mismatch is not an outage: retrying is guaranteed to fail.
  if (/does not support (tools|tool calling|images)|tool[_ ]calling is not supported/i.test(text)) {
    return new PortError("model_capability", text, false);
  }
  if (/\b402\b|insufficient balance|quota/i.test(text)) {
    return new PortError("provider_unavailable", text, false);
  }
  if (/\b(401|403)\b|unauthor|invalid api key|authentication/i.test(text)) {
    return new PortError("auth", text, false);
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) {
    return new PortError("rate_limited", text, true);
  }
  if (/timeout|timedout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|\b5\d\d\b/i.test(text)) {
    return new PortError("provider_unavailable", text, true);
  }
  return new PortError("provider_unavailable", text, false);
}

export interface PiModelOptions {
  models: Models;
  model: Model<Api>;
  /** Tool surface offered to the model. Empty means a text-only run. */
  specs?: readonly ToolSpec[];
  systemPrompt?: string;
}

export interface PiModelPort extends ModelPort {
  readonly tools: readonly PiTool[];
  getLastUsage(): ModelUsage | null;
}

function systemPromptFor(specs: readonly ToolSpec[]): string {
  const lines = [
    "You are TinyCode, a small coding agent working inside one workspace.",
    "Each step you either call exactly one tool or answer the user.",
  ];
  if (specs.length === 0) {
    lines.push("No tools are available in this run: answer from what you were given.");
  } else {
    lines.push("Available tools: " + specs.map((t) => t.name).join(", ") + ".");
    lines.push("After changing a file, call run_check before answering.");
  }
  lines.push("If a tool is refused or missing, say so plainly instead of claiming success.");
  return lines.join("\n");
}

export function createPiModelPort(options: PiModelOptions): PiModelPort {
  const specs = options.specs ?? TOOL_SPECS;
  const tools = specs.map(toPiTool);
  const systemPrompt = options.systemPrompt ?? systemPromptFor(specs);
  let lastUsage: ModelUsage | null = null;

  return {
    tools,
    getLastUsage() {
      return lastUsage;
    },
    async decide(state, signal, progress): Promise<Decision> {
      signal.throwIfAborted();

      const context: Context = {
        systemPrompt,
        messages: toPiMessages(state.messages, options.model),
        tools,
      };

      let message: AssistantMessage;
      try {
        message = await streamToMessage(options.models, options.model, context, signal, progress);
      } catch (error) {
        if (signal.aborted) throw error;
        const text = error instanceof Error ? error.message : String(error);
        throw mapProviderError(text);
      }

      if (message.stopReason === "error") {
        throw mapProviderError(message.errorMessage);
      }
      if (message.stopReason === "aborted") {
        if (signal.aborted) signal.throwIfAborted();
        throw new PortError("timeout", "request aborted by provider", true);
      }

      lastUsage = {
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cacheReadTokens: message.usage.cacheRead,
        cacheWriteTokens: message.usage.cacheWrite,
        model: message.model,
      };

      const call = message.content.find(isToolCall);
      if (call) {
        return {
          kind: "call_tool",
          toolCallId: call.id,
          intent: { name: call.name, arguments: call.arguments as Record<string, unknown> },
        };
      }

      const text = textOf(message);
      if (message.stopReason === "length") {
        throw new PortError("runtime_error", "model stopped on length before producing a decision");
      }
      return { kind: "respond", content: text };
    },
  };
}

/**
 * Resolve a runnable model without leaking the SDK into the product surface.
 * Returns null when no provider credentials are configured -- a fact the CLI must
 * report honestly rather than crash on.
 */
export async function resolvePiModel(requested?: string): Promise<{ models: Models; model: Model<Api> } | null> {
  const { builtinModels, getBuiltinModel } = await import("@earendil-works/pi-ai/providers/all");
  const models = builtinModels();

  if (requested) {
    const cut = requested.indexOf("/");
    const provider = requested.slice(0, cut);
    const id = requested.slice(cut + 1);
    if (cut <= 0 || id.length === 0) {
      throw new PortError("invalid_tool", "--model must look like provider/modelId");
    }
    return { models, model: getBuiltinModel(provider as never, id as never) };
  }

  const available = await models.getAvailable();
  const model = available[0];
  return model ? { models, model } : null;
}

export interface LocalEndpointOptions {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1 for ollama. */
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * A local OpenAI-compatible endpoint (ollama, llama.cpp, vLLM, LM Studio).
 * Keyless by design: `resolve` returns a placeholder auth result so the SDK never
 * goes looking for a credential this endpoint does not have.
 *
 * This is the path that makes a real network round-trip possible with no API key --
 * exactly the gap the README records as unverified.
 */
export async function resolveLocalModel(
  options: LocalEndpointOptions,
): Promise<{ models: Models; model: Model<Api> }> {
  const { createModels, createProvider } = await import("@earendil-works/pi-ai");
  const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");

  const providerId = "local-openai-compatible";
  const model = {
    id: options.modelId,
    name: options.modelId,
    api: "openai-completions",
    provider: providerId,
    baseUrl: options.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? 32_000,
    maxTokens: options.maxTokens ?? 4_000,
  } as unknown as Model<Api>;

  const provider = createProvider({
    id: providerId,
    name: "Local OpenAI-compatible endpoint",
    baseUrl: options.baseUrl,
    auth: {
      apiKey: {
        name: "Local endpoint (keyless)",
        resolve: async () => ({ auth: { apiKey: "local" }, source: "local-endpoint" }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

/**
 * Drain the provider stream, forwarding token deltas, and return the final message.
 *
 * Always streams -- one code path, not two. The skill's event protocol is explicit
 * (`text_delta` / `thinking_delta` / `done` / `error`), so there is no reason to keep a
 * separate non-streaming branch that would drift from this one.
 */
async function streamToMessage(
  models: Models,
  model: Model<Api>,
  context: Context,
  signal: AbortSignal,
  progress: ModelProgress | undefined,
): Promise<AssistantMessage> {
  const stream = models.stream(model, context, { signal });
  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        progress?.onTextDelta?.(event.delta);
        break;
      case "thinking_delta":
        progress?.onThinkingDelta?.(event.delta);
        break;
      case "done":
        return event.message;
      case "error":
        // Carries stopReason "error" | "aborted"; the caller maps it to a RunErrorCode.
        return event.error;
      default:
        break;
    }
  }
  throw new PortError("runtime_error", "provider stream ended without a terminal event");
}

// ---------------------------------------------------------------- real tools

export interface SandboxOptions {
  /** Absolute workspace root. Nothing outside it may be read or written. */
  root: string;
  checkCommand: string;
  checkTimeoutMs?: number;
  maxListEntries?: number;
  maxFileBytes?: number;
}

function safeResolve(root: string, requested: string): string {
  if (requested.length === 0) throw new PortError("invalid_tool", "empty path");
  const absolute = resolve(root, requested);
  const fromRoot = relative(root, absolute);
  if (fromRoot.startsWith("..") || fromRoot.includes(".." + sep)) {
    throw new PortError("invalid_tool", "path escapes the workspace: " + requested);
  }
  return absolute;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".tinycode"]);

async function listTree(root: string, maxEntries: number): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 2 || found.length >= maxEntries) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= maxEntries) return;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        found.push(rel);
      }
    }
  }
  await walk(root, 0);
  return found;
}

export function createSandboxToolPort(options: SandboxOptions): ToolPort {
  const root = resolve(options.root);
  const maxEntries = options.maxListEntries ?? 200;
  const maxFileBytes = options.maxFileBytes ?? 200_000;
  const checkTimeoutMs = options.checkTimeoutMs ?? 30_000;

  return {
    async execute(toolCallId, intent, signal): Promise<Observation> {
      signal.throwIfAborted();
      const observedAt = Date.now();
      const base = { toolCallId, name: intent.name, observedAt };

      switch (intent.name) {
        case "list_files": {
          const dir = stringArg(intent, "dir") ?? ".";
          const target = safeResolve(root, dir);
          const info = await stat(target).catch(() => null);
          if (!info || !info.isDirectory()) {
            return { ...base, ok: false, summary: "not a directory: " + dir, data: null };
          }
          const names = (await listTree(target, maxEntries)).map((p) =>
            dir === "." ? p : dir.replace(/\/+$/, "") + "/" + p,
          );
          return { ...base, ok: true, summary: names.join("\n"), data: names };
        }
        case "read_file": {
          const path = stringArg(intent, "path");
          if (!path) throw new PortError("invalid_tool", "read_file requires 'path'");
          const target = safeResolve(root, path);
          const content = await readFile(target, "utf8").catch(() => null);
          if (content === null) return { ...base, ok: false, summary: "not found: " + path, data: null };
          if (content.length > maxFileBytes) {
            return { ...base, ok: false, summary: "file too large: " + path, data: null };
          }
          return { ...base, ok: true, summary: truncate(content), data: content };
        }
        case "write_file": {
          const path = stringArg(intent, "path");
          const content = stringArg(intent, "content");
          if (!path || content === undefined) {
            throw new PortError("invalid_tool", "write_file requires 'path' and 'content'");
          }
          const target = safeResolve(root, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, "utf8");
          return { ...base, ok: true, summary: "wrote " + content.length + " chars to " + path, data: null };
        }
        case "run_check": {
          const outcome = await runCheck(root, options.checkCommand, checkTimeoutMs, signal);
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

function runCheck(
  cwd: string,
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CheckOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < 8000) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = (passed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise({ command, passed, output: truncate(output, 4000) });
    };
    child.on("error", (error) => {
      output += "\n" + error.message;
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}
