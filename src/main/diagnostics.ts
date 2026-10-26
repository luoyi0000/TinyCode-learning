import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Startup diagnostics that must survive whatever kills the process.
 *
 * Deliberately imports NOTHING from electron: if the failure is that `electron`
 * cannot be required at all (for example ELECTRON_RUN_AS_NODE is set, which turns
 * Electron into plain Node and makes require("electron") return a path string),
 * this file still runs and still records the facts.
 *
 * It executes at import time on purpose, and main/index.ts imports it first. Note
 * what the bundler actually does: Rollup hoists the external `require("electron")`
 * to the top of the bundle, ABOVE this module. That is fine -- requiring electron
 * does not throw in either mode (in ELECTRON_RUN_AS_NODE it returns a path string).
 * The failure we care about happens when the app USES the API, and this module runs
 * before that.
 */

export const LOG_PATH = join(tmpdir(), "tinycode-startup.log");

export function trace(stage: string, extra?: unknown): void {
  const suffix = extra === undefined ? "" : " " + safe(extra);
  try {
    appendFileSync(LOG_PATH, new Date().toISOString() + " " + stage + suffix + "\n");
  } catch {
    // Never let diagnostics become the failure.
  }
}

function safe(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function install(): void {
  trace("boot", {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    processType: process.type ?? null,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    argv: process.argv.slice(0, 3),
    cwd: process.cwd(),
  });

  process.on("uncaughtException", (error) => {
    trace("uncaughtException", { message: error.message, stack: String(error.stack).slice(0, 900) });
  });
  process.on("unhandledRejection", (reason) => {
    trace("unhandledRejection", reason instanceof Error ? reason.message : safe(reason));
  });
  process.on("exit", (code) => trace("exit", code));
}

install();
