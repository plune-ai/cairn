import { isAbsolute, relative, resolve, win32 } from "node:path";

/**
 * Resolve `path` under `dir`, or return undefined when it would land outside `dir` (#259): a `..`
 * climb, or an absolute path in either platform's form (`/x`, `C:/x`, `C:\x`), so a generated path
 * never writes outside the folder it was meant for, whatever OS runs Cairn. Shared by every writer
 * that places model-chosen paths (run-private `tests/`, `journeys/`, flow snapshots, project eject).
 */
export function resolveInside(dir: string, path: string): string | undefined {
  if (isAbsolute(path) || win32.isAbsolute(path)) return undefined;
  const target = resolve(dir, path);
  const rel = relative(dir, target);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : target;
}
