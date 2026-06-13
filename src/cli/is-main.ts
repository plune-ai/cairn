import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Is this module the process entry point?
 *
 * Naive `import.meta.url === pathToFileURL(process.argv[1]).href` BREAKS when the bin is a
 * symlink — Node resolves `import.meta.url` to the REAL path while `process.argv[1]` stays the
 * symlink path. That happens for `npm link` AND for `npm i -g` on Linux/macOS (the global bin is
 * a symlink), making the CLI silently no-op. Comparing the realpath of BOTH sides fixes it.
 */
export function isMainEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
