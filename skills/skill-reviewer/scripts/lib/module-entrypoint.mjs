import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Return true when a module is the process entrypoint, including symlinked installs. */
export function isMainModule(metaUrl, entryPath = process.argv[1]) {
  if (!entryPath) return false;
  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync(resolve(entryPath)) === realpathSync(modulePath);
  } catch {
    return resolve(entryPath) === resolve(modulePath);
  }
}
