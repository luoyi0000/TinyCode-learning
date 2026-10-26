#!/usr/bin/env node
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Repairs a node_modules/electron install whose binary never landed.
 *
 * Why this exists: `node install.js` fetches SHASUMS from the network before it will
 * use an already-cached zip, so on a restricted connection it fails even though the
 * zip is sitting in %LOCALAPPDATA%/electron/Cache. This extracts that zip and writes
 * path.txt correctly.
 *
 * path.txt must contain exactly `electron.exe`: electron/index.js does
 * path.join(__dirname, "dist", <path.txt contents>), so a `dist/` prefix doubles the
 * directory and a trailing newline ends up inside the filename (ENOENT).
 */

const projectRoot = dirname(import.meta.dirname ?? process.cwd());
const electronDir = join(projectRoot, "node_modules", "electron");
const distDir = join(electronDir, "dist");
const exeName = process.platform === "win32" ? "electron.exe" : "electron";

function electronVersion() {
  const pkg = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8"));
  return pkg.version;
}

function findCachedZip(version) {
  const cacheRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "electron", "Cache")
    : join(homedir(), "Library", "Caches", "electron");
  if (!existsSync(cacheRoot)) return null;
  const wanted = "electron-v" + version + "-";
  for (const bucket of readdirSync(cacheRoot)) {
    const dir = join(cacheRoot, bucket);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (file.startsWith(wanted) && file.endsWith(".zip")) return join(dir, file);
    }
  }
  return null;
}

const version = electronVersion();
const exe = join(distDir, exeName);

if (!existsSync(exe)) {
  const zip = findCachedZip(version);
  if (!zip) {
    console.error("no cached zip for electron " + version + "; run: npm rebuild electron");
    process.exit(2);
  }
  console.log("extracting " + zip);
  await mkdir(distDir, { recursive: true });
  const result = spawnSync("unzip", ["-q", "-o", zip, "-d", distDir], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("unzip failed");
    process.exit(2);
  }
}

// Exactly `electron.exe`, no prefix, no newline.
await writeFile(join(electronDir, "path.txt"), exeName, "utf8");

const resolved = join(distDir, readFileSync(join(electronDir, "path.txt"), "utf8"));
console.log("electron " + version);
console.log("path.txt -> " + JSON.stringify(readFileSync(join(electronDir, "path.txt"), "utf8")));
console.log("executable exists: " + existsSync(resolved) + "  (" + resolved + ")");
if (!existsSync(resolved)) process.exit(1);
// ---------------------------------------------------------------- OneDrive guard
//
// Electron cannot load its own DLLs from a OneDrive-synced directory on this machine:
// the same binary exits 3 with no output from OneDrive and runs perfectly from a local
// path. Reading the app's JS from OneDrive is fine, so pointing the ELECTRON BINARY at
// a local copy is enough -- the project can stay where it is.
//
// electron/index.js honours ELECTRON_OVERRIDE_DIST_PATH, so we seed a local dist and
// print the variable to export.

const localDist = join(process.env.LOCALAPPDATA ?? homedir(), "tinycode-electron-dist");

if (process.platform === "win32") {
  const source = join(electronDir, "dist");
  const sameplace = localDist.toLowerCase() === source.toLowerCase();
  if (!sameplace) {
    await rm(localDist, { recursive: true, force: true });
    await cp(source, localDist, { recursive: true });
    console.log("seeded local electron dist: " + localDist);
  }
  console.log("");
  console.log("If this project lives under OneDrive, start Electron from the local copy:");
  console.log('  $env:ELECTRON_OVERRIDE_DIST_PATH = "' + localDist + '"');
  console.log("  npm run dev:desktop");
}
