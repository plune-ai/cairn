import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PageStudy } from "../observe/index.js";
import type { GeneratedSuite } from "../codegen/index.js";

/** Codes Windows throws when a just-exited process still holds a handle on a dir/file. */
const LOCK_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Resilient recursive remove (#101). On Windows the Playwright runner from a just-finished validation
 * can still hold a handle under `tests/`, so `rm` throws EBUSY/EPERM transiently; `force: true` only
 * swallows ENOENT, not locks. Retry with exponential backoff to let the handle clear. On POSIX (no file
 * locking) the first attempt always wins, so the path is unchanged there. If the locks never clear, give
 * up cleanly (best-effort) instead of rejecting the whole run — the following mkdir + per-file writes
 * still produce a usable tree. Non-lock errors propagate immediately. `rmFn` is injected for testing.
 */
export async function rmrf(path: string, rmFn: typeof rm = rm, retries = 4, baseMs = 100): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rmFn(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code || !LOCK_CODES.has(code)) throw e; // a real error → surface it
      if (attempt >= retries) return; // locks never cleared → best-effort, don't sink the run
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
    }
  }
}

export interface RunWriter {
  runId: string;
  dir: string;
  writeStudy(study: PageStudy): Promise<void>;
  /** Writes spec files to tests/; returns the absolute paths written. Blocks traversal. */
  writeSuite(suite: GeneratedSuite): Promise<string[]>;
  writeReport(report: unknown): Promise<void>;
  writeScreenshot(b64: string): Promise<void>;
  /** ARIA snapshot as a separate readable file (snapshots/aria.yaml). */
  writeAria(yaml: string): Promise<void>;
  /** Human-readable Markdown report with selectors (report.md). */
  writeReportMd(md: string): Promise<void>;
  /** Run log (run.log). */
  writeLog(text: string): Promise<void>;
  /** Test cases in the user's format → testcases/<id>.md; returns the paths. */
  writeTestCases(docs: { id: string; md: string }[]): Promise<string[]>;
  /** #60: journey spec files (with setup) → journeys/; clean-start; returns the paths written. */
  writeJourneySpecs(files: { path: string; content: string }[]): Promise<string[]>;
  /** #103: per-page crawl snapshots — each page's aria.yaml + screenshot.png under its own dir. */
  writeFlowSnapshots(pages: { dir: string; ariaYaml: string; screenshotB64: string }[]): Promise<void>;
}

/** Local trail of each run: runs/<id>/ (study, tests, snapshots, report). */
export class ArtifactStore {
  constructor(private readonly baseDir: string) {}

  async openRun(runId: string): Promise<RunWriter> {
    const dir = resolve(this.baseDir, runId);
    const testsDir = join(dir, "tests");
    await mkdir(testsDir, { recursive: true });

    return {
      runId,
      dir,
      writeStudy: async (study) => {
        await writeFile(join(dir, "study.json"), JSON.stringify(study, null, 2), "utf8");
      },
      writeSuite: async (suite) => {
        // Clean start: every generation (including repair) fully overwrites tests/.
        await rmrf(testsDir);
        await mkdir(testsDir, { recursive: true });
        const out: string[] = [];
        for (const f of suite.files) {
          const target = resolve(testsDir, f.path);
          const rel = relative(testsDir, target);
          if (rel.startsWith("..") || isAbsolute(rel)) continue; // traversal — skip
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.content, "utf8");
          out.push(target);
        }
        return out;
      },
      writeReport: async (report) => {
        await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
      },
      writeScreenshot: async (b64) => {
        const snaps = join(dir, "snapshots");
        await mkdir(snaps, { recursive: true });
        await writeFile(join(snaps, "screenshot.png"), Buffer.from(b64, "base64"));
      },
      writeAria: async (yaml) => {
        const snaps = join(dir, "snapshots");
        await mkdir(snaps, { recursive: true });
        await writeFile(join(snaps, "aria.yaml"), yaml, "utf8");
      },
      writeReportMd: async (md) => {
        await writeFile(join(dir, "report.md"), md, "utf8");
      },
      writeLog: async (text) => {
        await writeFile(join(dir, "run.log"), text, "utf8");
      },
      writeTestCases: async (docs) => {
        const tcDir = join(dir, "testcases");
        await mkdir(tcDir, { recursive: true });
        const out: string[] = [];
        for (const d of docs) {
          const p = join(tcDir, `${d.id}.md`);
          await writeFile(p, d.md, "utf8");
          out.push(p);
        }
        return out;
      },
      writeJourneySpecs: async (files) => {
        // Clean start (like writeSuite) but a SEPARATE tree — never touches tests/.
        const jDir = join(dir, "journeys");
        await rmrf(jDir);
        await mkdir(jDir, { recursive: true });
        const out: string[] = [];
        for (const f of files) {
          const rel0 = f.path.replace(/^journeys[/\\]/, ""); // paths are emitted as "journeys/<id>.spec.ts"
          const target = resolve(jDir, rel0);
          const rel = relative(jDir, target);
          if (rel.startsWith("..") || isAbsolute(rel)) continue; // traversal — skip
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.content, "utf8");
          out.push(target);
        }
        return out;
      },
      writeFlowSnapshots: async (pages) => {
        for (const p of pages) {
          const pdir = resolve(dir, p.dir);
          const rel = relative(dir, pdir);
          if (rel.startsWith("..") || isAbsolute(rel)) continue; // traversal — skip
          await mkdir(pdir, { recursive: true });
          await writeFile(join(pdir, "aria.yaml"), p.ariaYaml, "utf8");
          if (p.screenshotB64) {
            await writeFile(join(pdir, "screenshot.png"), Buffer.from(p.screenshotB64, "base64"));
          }
        }
      },
    };
  }
}
