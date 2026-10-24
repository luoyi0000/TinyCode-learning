import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Electron security, asserted against the SOURCE.
 *
 * These are static checks on purpose: the security-relevant settings are declarations,
 * and a declaration that silently drifts is exactly how an app becomes unsafe. They do
 * not replace launching the app, they stop the regression that would make it unsafe
 * once it does launch.
 */

const root = resolve(process.cwd());
const read = (rel: string) => readFile(resolve(root, rel), "utf8");

test("every BrowserWindow keeps the three security pillars", async () => {
  const main = await read("src/main/index.ts");
  for (const required of [
    "contextIsolation: true",
    "sandbox: true",
    "nodeIntegration: false",
    "webviewTag: false",
    "allowRunningInsecureContent: false",
    "experimentalFeatures: false",
  ]) {
    assert.ok(main.includes(required), "missing webPreferences: " + required);
  }
});

test("the renderer cannot navigate away or open windows", async () => {
  const main = await read("src/main/index.ts");
  assert.ok(main.includes("setWindowOpenHandler"), "new windows must be denied");
  assert.ok(main.includes("will-navigate"), "navigation must be blocked");
  assert.ok(main.includes("Content-Security-Policy"), "a CSP must be applied");
});

test("the preload never hands the renderer raw ipcRenderer", async () => {
  const preload = await read("src/preload/index.ts");
  assert.equal(/exposeInMainWorld\(\s*["\x27][^"\x27]+["\x27]\s*,\s*ipcRenderer\s*\)/.test(preload), false,
    "raw ipcRenderer must never be exposed");
  // Every invoke must target a named constant, never a caller-supplied string.
  const invokes = preload.match(/ipcRenderer\.(invoke|on|removeListener)\(([^)]*)/g) ?? [];
  assert.ok(invokes.length > 0, "expected named IPC calls");
  for (const call of invokes) {
    assert.match(call, /CHANNEL_[A-Z_]+/, "IPC call must use a named channel: " + call);
  }
});

test("the preload stays sandbox-safe: no node builtins", async () => {
  const preload = await read("src/preload/index.ts");
  for (const forbidden of ["node:fs", "node:child_process", "node:path", "require("]) {
    assert.equal(preload.includes(forbidden), false, "preload must not use " + forbidden);
  }
});

test("the renderer never reaches the SDK or the filesystem", async () => {
  const files = ["src/renderer/src/App.tsx", "src/renderer/src/view-model.ts", "src/renderer/src/main.tsx"];
  for (const file of files) {
    const text = await read(file);
    assert.equal(text.includes("@earendil-works/"), false, file + " must not import the SDK");
    assert.equal(text.includes("node:"), false, file + " must not import node builtins");
  }
});

