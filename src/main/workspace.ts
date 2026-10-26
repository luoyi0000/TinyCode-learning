import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface WorkspacePaths {
  /** app.getAppPath() -- the directory holding the application's own source. */
  appPath: string;
  /** app.getPath("userData") -- where the app may freely create a sandbox. */
  userDataPath: string;
}

/**
 * Where the agent is allowed to work.
 *
 * Two guards, both structural rather than prompt-based:
 *   1. An empty value means a dedicated sandbox under userData -- never the app dir.
 *   2. A path inside the application directory is refused outright, because a coding
 *      agent that can edit its own source can change its own behaviour.
 *
 * Pure on purpose: no electron import, so the rule is unit-testable.
 */
export function resolveWorkspace(requested: string, paths: WorkspacePaths): string {
  if (!requested.trim()) {
    const fallback = resolve(paths.userDataPath, "workspace");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  const appPath = resolve(paths.appPath);
  const absolute = resolve(requested);
  if (absolute === appPath || absolute.startsWith(appPath + sep)) {
    throw new Error(
      "workspace refuses to point inside the application directory: the agent must not edit its own source",
    );
  }
  mkdirSync(absolute, { recursive: true });
  return absolute;
}
