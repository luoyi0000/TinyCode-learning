import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Format decisions, each forced by a measured constraint (not preference):
//
//   main    -> CJS (.cjs). An ESM main cannot import the built-in `electron` module
//              on Electron 33 / Node 20.18.3 (verified with a 2-line probe: bare
//              `import { app } from "electron"` dies in cjsPreparseModuleExports).
//              CJS is therefore forced, which in turn is why src/adapters/pi.ts
//              imports the ESM-only SDK for TYPES ONLY and reaches it through
//              dynamic import().
//   preload -> CJS (.cjs). A SANDBOXED preload cannot be ESM, and it never imports
//              the SDK, so CJS costs nothing here.
//
// The explicit extensions keep both unambiguous under package.json type=module.
const mainCjs = { rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } } as const;
const preloadCjs = { rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } } as const;

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: mainCjs },
  preload: { plugins: [externalizeDepsPlugin()], build: preloadCjs },
  renderer: { plugins: [react()] },
});
