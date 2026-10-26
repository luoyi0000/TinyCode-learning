// MUST be the first import: its side effects have to run before the electron require
// below, otherwise a failure inside that require leaves no trace at all.
import { trace } from "./diagnostics.ts";

import { existsSync } from "node:fs";
import { join } from "node:path";

import { BrowserWindow, app, session, shell } from "electron";

import { registerRunHandlers } from "./ipc/run-handlers.ts";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

/**
 * electron-vite emits the preload bundle somewhere under out/preload, and the exact
 * extension depends on whether the package is ESM. Rather than guess, probe the
 * candidates -- and fall back loudly to the first one if none exist.
 */
function resolvePreload(): string {
  const base = join(app.getAppPath(), "out", "preload");
  for (const name of ["index.cjs", "index.js"]) {
    const candidate = join(base, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(base, "index.js");
}

/**
 * Content Security Policy. Dev additionally allows the Vite dev server and its HMR
 * websocket; production is locked to 'self'. Inline styles stay allowed because the
 * renderer ships a small stylesheet through the bundler.
 */
function applyCsp(): void {
  const dev = "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-inline' http://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:*";
  const prod = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [isDev ? dev : prod],
      },
    });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    backgroundColor: "#0f1115",
    webPreferences: {
      // The three pillars. Disabling any one of them turns an XSS into RCE.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      preload: resolvePreload(),
    },
  });

  win.once("ready-to-show", () => {
    trace("window ready-to-show");
    win.show();
  });

  // Silent failures live here: a preload that throws does not crash the app, it just
  // leaves window.tinycode undefined and every button dead.
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    trace("preload-error", { preloadPath, message: error.message });
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    trace("did-fail-load", { code, description, url });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    trace("render-process-gone", details);
  });

  // Never let the renderer navigate away or spawn windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (isDev && devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(app.getAppPath(), "out", "renderer", "index.html"));
  }
  return win;
}

void app.whenReady().then(() => {
  trace("app ready", { appPath: app.getAppPath(), preload: resolvePreload() });
  applyCsp();
  const logDir = join(app.getPath("userData"), "runs");
  registerRunHandlers(() => BrowserWindow.getAllWindows()[0]!.webContents, logDir);
  createWindow();
  trace("window created");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  trace("window-all-closed");
  if (process.platform !== "darwin") app.quit();
});
