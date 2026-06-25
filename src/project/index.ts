/**
 * INT-03 (#51) — plug into existing Playwright projects.
 *
 * Detect a host project's Playwright setup (`playwright.config.{ts,js,mjs,cjs}`) and resolve the
 * conventions Cairn must respect when EJECTING generated specs into it instead of the greenfield
 * `runs/<id>/tests` folder: the `testDir` the project's runner discovers, and the spec-filename
 * suffix (`.spec.ts` vs `.test.ts`) implied by `testMatch`.
 *
 * Leaf module — depends only on node fs/path (and the codegen `FileBlob` type). Detection is opt-in
 * (the `--into-project` flag); without it nothing here runs and the greenfield path is unchanged.
 *
 * Config parsing is best-effort (text regex, not evaluation): a TS/JS/ESM config can't be imported
 * cheaply and safely, so we read the well-known keys from source. A missed key falls back to the
 * Playwright default (testDir = the config's own directory; suffix = `.spec.ts`).
 */
import { stat, readFile, mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import type { FileBlob } from "../codegen/index.js";

/** Playwright config filenames, in the order Playwright itself resolves them. */
export const PW_CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
] as const;

/** A spec filename: `<name>.spec.ts` or `<name>.test.ts` (the infix Cairn writes). */
export type SpecSuffix = ".spec.ts" | ".test.ts";

export interface ProjectTarget {
  /** Absolute directory the project's runner discovers specs in (where Cairn writes). */
  testDir: string;
  /** Spec-filename suffix derived from the project's `testMatch` (default `.spec.ts`). */
  specSuffix: SpecSuffix;
  /** Absolute path to the detected `playwright.config.*` (undefined when a bare dir was given). */
  configPath?: string;
}

/** Matches any Playwright spec/test filename so its infix+extension can be normalized to the project suffix. */
const SPEC_FILE_RE = /\.(spec|test)\.(c|m)?[jt]sx?$/i;

/** Does this generated file look like a runnable spec (vs a POM/helper that keeps its name)? */
export function isSpecFile(name: string): boolean {
  return SPEC_FILE_RE.test(name);
}

/** Walk up from `startDir` (inclusive) to the filesystem root, returning the nearest Playwright config. */
export async function findPlaywrightConfig(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of PW_CONFIG_NAMES) {
      const candidate = join(dir, name);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // not here — try the next name / parent
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the root
    dir = parent;
  }
}

/**
 * Best-effort parse of `testDir` + spec suffix from a Playwright config's SOURCE TEXT.
 * `testDir` → absolute (resolved against the config's dir); a missing/non-literal value falls back to
 * the Playwright default (the config's own directory). The suffix is `.test.ts` only when `testMatch`
 * clearly targets `.test.` and not `.spec.`; otherwise the conventional `.spec.ts`.
 */
export function parseConfigConventions(
  configText: string,
  configDir: string,
): { testDir: string; specSuffix: SpecSuffix } {
  // testDir: '...'  /  testDir: "..."  /  testDir: `...`  (string literals only — best effort)
  const testDirRel = /testDir\s*:\s*(['"`])([^'"`]+)\1/.exec(configText)?.[2];
  const testDir = testDirRel ? resolve(configDir, testDirRel) : resolve(configDir);

  // testMatch can be a string, RegExp, or array (single- or multi-line). We only flip to `.test.ts`
  // when the value clearly mentions `test` and NOT `spec` — a safe, conservative read of a ~160-char
  // window after the key (default stays `.spec.ts`). Anything ambiguous keeps the convention.
  let specSuffix: SpecSuffix = ".spec.ts";
  const keyIdx = configText.search(/testMatch\s*:/);
  if (keyIdx >= 0) {
    const window = configText.slice(keyIdx, keyIdx + 160);
    const mentionsTest = /\.test\.|\btest\b/i.test(window);
    const mentionsSpec = /\.spec\.|\bspec\b/i.test(window);
    if (mentionsTest && !mentionsSpec) specSuffix = ".test.ts";
  }
  return { testDir, specSuffix };
}

/**
 * Resolve where to write specs for an existing Playwright project.
 *  - `dir` given → search it (and up) for a config; if none, treat `dir` itself as the testDir
 *    (the explicit `--into-project ./e2e` request is honored even without a config).
 *  - no `dir` → search from `cwd` upward; returns undefined when no config exists (caller falls back
 *    to the greenfield `runs/` behavior, with a clear message — no regression).
 */
export async function resolveProjectTarget(opts: {
  cwd?: string;
  dir?: string;
}): Promise<ProjectTarget | undefined> {
  const startDir = resolve(opts.dir ?? opts.cwd ?? process.cwd());
  const configPath = await findPlaywrightConfig(startDir);
  if (configPath) {
    const text = await readFile(configPath, "utf8").catch(() => "");
    const { testDir, specSuffix } = parseConfigConventions(text, dirname(configPath));
    return { testDir, specSuffix, configPath };
  }
  if (opts.dir) {
    // Explicit target dir without a config: write there with the default suffix.
    return { testDir: resolve(opts.dir), specSuffix: ".spec.ts" };
  }
  return undefined;
}

export interface PlannedFile {
  /** Final relative path under the testDir (POSIX separators). */
  rel: string;
  content: string;
  /** Set when a collision forced a rename (original generated path) — surfaced for logging. */
  renamedFrom?: string;
}

/** Normalize a generated filename to the project's spec suffix; non-spec files (POM/helpers) keep their name. */
function applySuffix(rel: string, suffix: SpecSuffix): string {
  if (!isSpecFile(rel)) return rel;
  return rel.replace(SPEC_FILE_RE, suffix);
}

/** Insert a `.cairn`/`.cairn-N` disambiguator before the spec infix or extension to dodge a collision. */
function disambiguate(rel: string, attempt: number): string {
  const tag = attempt === 1 ? "cairn" : `cairn-${attempt - 1}`;
  if (SPEC_FILE_RE.test(rel)) {
    // foo.spec.ts → foo.cairn.spec.ts
    return rel.replace(SPEC_FILE_RE, (m) => `.${tag}${m}`);
  }
  const p = parsePath(rel);
  const dir = p.dir ? `${p.dir}/` : "";
  return `${dir}${p.name}.${tag}${p.ext}`;
}

/**
 * Pure placement planner (#51): map generated files → final relative paths under the project testDir,
 * normalizing the spec suffix and dodging collisions. `isTaken(rel)` reports paths already present
 * (pre-existing project files) so an existing spec is NEVER overwritten — Cairn renames its own file
 * instead. Deterministic and side-effect-free for unit testing.
 */
export function planPlacement(
  files: FileBlob[],
  specSuffix: SpecSuffix,
  isTaken: (relPosix: string) => boolean,
): PlannedFile[] {
  const used = new Set<string>();
  const taken = (rel: string): boolean => used.has(rel) || isTaken(rel);
  const out: PlannedFile[] = [];
  for (const f of files) {
    const normalized = applySuffix(f.path.replace(/\\/g, "/"), specSuffix);
    let rel = normalized;
    let attempt = 0;
    while (taken(rel)) rel = disambiguate(normalized, ++attempt);
    used.add(rel);
    out.push({ rel, content: f.content, ...(rel !== normalized ? { renamedFrom: f.path } : {}) });
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface EjectResult {
  /** Absolute paths written into the project's testDir. */
  written: string[];
  /** Collisions Cairn dodged by renaming its own file (original → final relative path). */
  renamed: { from: string; to: string }[];
  testDir: string;
}

/**
 * Eject a generated suite into the project's testDir (#51): collision-safe, non-destructive — it
 * never deletes or overwrites a pre-existing file (unlike the greenfield `writeSuite`, which cleans
 * its run-private `tests/` on every attempt). Subdirectories in generated paths (e.g. POM `pages/`)
 * are preserved; only the spec infix is normalized to the project's convention.
 */
export async function ejectSuiteToProject(files: FileBlob[], target: ProjectTarget): Promise<EjectResult> {
  await mkdir(target.testDir, { recursive: true });
  const used = new Set<string>(); // names placed within THIS batch (avoid intra-batch collisions)
  const written: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  for (const f of files) {
    const normalized = applySuffix(f.path.replace(/\\/g, "/"), target.specSuffix);
    // A path is free when it is neither used in this batch nor already present on disk — so a
    // pre-existing project file is never overwritten; Cairn disambiguates its own file instead.
    let rel = normalized;
    let attempt = 0;
    while (used.has(rel) || (await pathExists(resolve(target.testDir, rel)))) {
      rel = disambiguate(normalized, ++attempt);
    }
    used.add(rel);
    const abs = resolve(target.testDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf8");
    written.push(abs);
    if (rel !== normalized) renamed.push({ from: f.path, to: rel });
  }
  return { written, renamed, testDir: target.testDir };
}
