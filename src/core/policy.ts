import type { ToolIntent, ToolName } from "./types.ts";

/**
 * Tool policy: an explicit allowlist, and untrusted results that get truncated
 * before they can influence the next decision.
 */

export interface ToolSpec {
  name: ToolName;
  description: string;
  /** Plain JSON Schema. The SDK adapter maps this; the Core never sees SDK types. */
  parameters: Record<string, unknown>;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "list_files",
    description: "List files under a workspace-relative directory.",
    parameters: {
      type: "object",
      properties: { dir: { type: "string", description: "Workspace-relative directory, default '.'" } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a workspace-relative text file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative file path" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Write the full contents of a workspace-relative text file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        content: { type: "string", description: "Full new file contents" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "run_check",
    description: "Run the project check command and report pass/fail with output.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

const ALLOWED: ReadonlySet<string> = new Set(TOOL_SPECS.map((t) => t.name));

export function isAllowedTool(name: string): name is ToolName {
  return ALLOWED.has(name);
}

export const MAX_OBSERVATION_CHARS = 1500;

/** Tool output is untrusted input: truncate at the source, mark that we did. */
export function truncate(text: string, max = MAX_OBSERVATION_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...[truncated " + (text.length - max) + " chars]";
}

export function stringArg(intent: ToolIntent, key: string): string | undefined {
  const value = intent.arguments[key];
  return typeof value === "string" ? value : undefined;
}
