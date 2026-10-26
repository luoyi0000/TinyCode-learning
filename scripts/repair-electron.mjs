#!/usr/bin/env node
/**
 * Repairs node_modules/electron so the binary can actually start.
 *
 * Two problems this solves, both measured on Windows:
 *
 * 1. electron's installer needs the network to verify SHASUMS even when the zip is
 *    already cached, so an offline `npm install` leaves dist/ missing. We extract the
 *    cached zip ourselves.
 *
 * 2. Electron cannot load its own DLLs from a OneDrive-synced directory: the same
 *    binary exits 3 with no output from OneDrive and runs fine from a local path.
 *    Reading the app's JS from OneDrive is fine, so only the binary must live locally.
 *    ELECTRON_OVERRIDE_DIST_PATH does NOT help -- electron-vite spawns
 *    node_modules/electron/dist/electron.exe directly. A directory junction does,
 *    because it makes that exact path resolve to local disk.
 *
 * path.txt must contain exactly `electron.exe`: index.js does
 * path.join(__dirname, "dist", <path.txt>), so a `dist/` prefix doubles the directory
 * and a trailing newline ends up inside the filename (ENOENT).
 *
 * Safe to re-run. Run it again after `npm install`, which replaces dist/.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = dirname(import.meta.dirname ?? process.cwd());
const electronDir = join(projectRoot, "node_modules", "electron");
const distDir = join(electronDir, "dist");
const exeName = process.platform === "win32" ? "electron.exe" : "electron";
const localDist = join(process.env.LOCALAPPDATA ?? homedir(), "tinycode-electron-dist");
const localExe = join(localDist, exeName);
const distExe = join(distDir, exeName);

const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const version = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8")).version;
console.log("electron " + version);

// 1) Break any existing junction FIRST. Deleting or copying through a link is what
//    corrupted the previous attempt: the link pointed at the directory being deleted.
if (isLink(distDir)) {
  console.log("removing existing junction at " + distDir);
  spawnSync("cmd", ["/c", "rmdir", distDir], { stdio: "ignore" });
}

// 2) Make sure the local copy holds a real binary.
if (!existsSync(localExe)) {
  if (existsSync(distExe)) {
    console.log("seeding local dist from " + distDir);
    await rm(localDist, { recursive: true, force: true });
    await cp(distDir, localDist, { recursive: true });
  } else {
    const cacheRoot = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "electron", "Cache")
      : join(homedir(), "Library", "Caches", "electron");
    const wanted = "electron-v" + version + "-";
    let zip = null;
    if (existsSync(cacheRoot)) {
      for (const bucket of readdirSync(cacheRoot)) {
        const dir = join(cacheRoot, bucket);
        if (!statSync(dir).isDirectory()) continue;
        for (const file of readdirSync(dir)) {
          if (file.startsWith(wanted) && file.endsWith(".zip")) zip = join(dir, file);
        }
      }
    }
    if (!zip) {
      console.error("no dist and no cached zip; run: npm rebuild electron");
      process.exit(2);
    }
    console.log("extracting " + zip);
    await rm(localDist, { recursive: true, force: true });
    await mkdir(localDist, { recursive: true });
    const unzip = spawnSync("unzip", ["-q", "-o", zip, "-d", localDist], { stdio: "inherit" });
    if (unzip.status !== 0) {
      const ps = spawnSync("powershell", ["-NoProfile", "-Command",
        "Expand-Archive -Path '" + zip + "' -DestinationPath '" + localDist + "' -Force"],
        { stdio: "inherit" });
      if (ps.status !== 0) {
        console.error("could not extract the cached zip");
        process.exit(2);
      }
    }
  }
}
if (!existsSync(localExe)) {
  console.error("local electron.exe still missing");
  process.exit(2);
}

// 3) path.txt: exactly the bare executable name.
await writeFile(join(electronDir, "path.txt"), exeName, "utf8");

// 4) Under OneDrive, make dist/ a junction to the local copy. Elsewhere, keep the
//    real directory -- there is nothing to work around.
const underOneDrive = projectRoot.toLowerCase().includes("onedrive");
if (underOneDrive && process.platform === "win32") {
  await rm(distDir, { recursive: true, force: true });
  const link = spawnSync("cmd", ["/c", "mklink", "/J", distDir, localDist], { stdio: "inherit" });
  if (link.status !== 0) {
    console.error("junction failed; Electron will keep failing from OneDrive");
    process.exit(2);
  }
  if (!isLink(distDir)) {
    console.error("dist is not a junction after mklink");
    process.exit(2);
  }
}

const resolved = join(electronDir, "dist", readFileSync(join(electronDir, "path.txt"), "utf8"));
console.log("path.txt        " + JSON.stringify(readFileSync(join(electronDir, "path.txt"), "utf8")));
console.log("dist is junction " + isLink(distDir));
console.log("binary reachable " + existsSync(resolved));
if (!existsSync(resolved)) process.exit(1);
console.log("");
console.log("run: npm run dev:desktop");
