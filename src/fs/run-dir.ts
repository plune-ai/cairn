/**
 * Robust resolution of user-supplied run-directory arguments (`--run` / `--from-run`).
 *
 * The Windows/Git-Bash trap: in MINGW64 an unquoted backslash is a shell ESCAPE, so
 * `--run runs\<id>` reaches the process as the glued string `runs<id>` (the separator is
 * eaten) BEFORE Node ever runs. We cannot un-eat it at display time — the fix lives at the
 * INPUT layer: accept a bare run id, recover the glued form, and otherwise fail with an
 * actionable message instead of a raw ENOENT.
 *
 * `src/fs/` is a dependency-free leaf — it must NOT import from `src/agent/` (a higher layer),
 * so the display normalization below is a small local copy of agent/summary.displayPath().
 */
import { resolve, isAbsolute, basename } from "node:path";
import { stat, readdir, readFile } from "node:fs/promises";

/** Forward-slash a path for DISPLAY only (POSIX slashes are valid on all three platforms). */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Single source of truth for the default runs base dir (was duplicated across agent/index.ts). */
export function defaultRunsBaseDir(): string {
  return resolve(process.cwd(), "runs");
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listRunDirs(base: string): Promise<string[]> {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface ResolveRunDirOptions {
  /** Where bare run ids live. Default: defaultRunsBaseDir(). */
  runsBaseDir?: string;
  /** Injectable for tests: does this absolute path point at an existing directory? */
  isDir?: (p: string) => Promise<boolean>;
  /** Injectable for tests: list the run-dir names under the base. */
  listRuns?: (base: string) => Promise<string[]>;
}

/** Build the actionable "run dir not found" message: what we tried, what's available, and how to avoid the trap. */
export function runDirNotFoundMessage(value: string, runsBaseDir: string, available: string[]): string {
  const lines = [`Run directory not found for "${value}".`, `  Tried: ${toPosix(resolve(value))} (does not exist).`, ""];
  if (available.length > 0) {
    lines.push(`Available runs in ${toPosix(runsBaseDir)}:`);
    for (const name of available.slice(0, 12)) lines.push(`  - ${name}`);
    if (available.length > 12) lines.push(`  …and ${available.length - 12} more`);
  } else {
    lines.push(
      `No runs found in ${toPosix(runsBaseDir)} (none yet — run \`cairn design --url <u>\` or \`cairn explore\` first).`,
    );
  }
  lines.push(
    "",
    "Tip: pass just the run id (e.g. --run <id>) or an absolute path.",
    "In Git Bash (MINGW64) an unquoted \\ is eaten by the shell — quote the path or use forward slashes: --run 'runs/<id>'.",
  );
  return lines.join("\n");
}

/**
 * Resolve a `--run`/`--from-run` value to an EXISTING run directory (absolute). See the module header.
 * Order (first hit wins):
 *   (a) literal path exists      → resolve(value)              [runs/<id>, ./runs/<id>, absolute, PowerShell `\`]
 *   (b) bare id under the base   → resolve(runsBaseDir, value) [`--run <uuid>`]
 *   (c) glued `<base><id>`       → resolve(runsBaseDir, captured) [Git-Bash eaten-separator recovery]
 *   (d) nothing matched          → throw runDirNotFoundMessage(...)
 * A non-existent ABSOLUTE path falls straight through to (d) — it is never re-joined under the base.
 */
export async function resolveRunDir(value: string, opts: ResolveRunDirOptions = {}): Promise<string> {
  const runsBaseDir = resolve(opts.runsBaseDir ?? defaultRunsBaseDir());
  const isDir = opts.isDir ?? dirExists;
  const listRuns = opts.listRuns ?? listRunDirs;

  // (a) literal path (relative/absolute/PowerShell `\`) — returned verbatim if it exists.
  const direct = resolve(value);
  if (await isDir(direct)) return direct;

  if (!isAbsolute(value)) {
    // (b) a bare run id living under the runs base dir.
    const inBase = resolve(runsBaseDir, value);
    if (await isDir(inBase)) return inBase;

    // (c) Git-Bash glued case: `<base-name><id>` with the separator eaten. Prefix is the base dir name.
    const captured = new RegExp(`^${escapeRe(basename(runsBaseDir))}(.+)$`, "i").exec(value)?.[1];
    if (captured) {
      const recovered = resolve(runsBaseDir, captured);
      if (await isDir(recovered)) return recovered;
    }
  }

  // (d) nothing matched — fail with an actionable message instead of a downstream ENOENT.
  throw new Error(runDirNotFoundMessage(value, runsBaseDir, await listRuns(runsBaseDir)));
}

/**
 * readFile, but a missing file becomes a friendly, actionable error (with the Git-Bash separator tip)
 * instead of a raw ENOENT. For arbitrary file flags (`--checklist`/`--dataset`/`--candidate`) where the
 * glued-path recovery used by resolveRunDir is impossible (no base+id convention to reconstruct from).
 */
export async function readInputFile(value: string, label: string): Promise<string> {
  try {
    return await readFile(value, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error(
        `${label} not found: ${toPosix(resolve(value))}.\n` +
          "In Git Bash (MINGW64) an unquoted \\ is eaten by the shell — quote the path or use forward slashes.",
      );
    }
    throw err;
  }
}
