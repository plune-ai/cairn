import { useEffect, useState } from "react";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface RunArtifacts {
  cases: { name: string; text: string }[];
  report: string;
  log: string;
  loading: boolean;
}

/** Loads one run's viewable artifacts: testcases/*.md, report.md, run.log. All best-effort. */
export function useRunArtifacts(dir: string): RunArtifacts & { reload: () => void } {
  const [state, setState] = useState<RunArtifacts>({ cases: [], report: "", log: "", loading: true });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cases: { name: string; text: string }[] = [];
      try {
        // Sort by name so the list order is stable (readdir order is filesystem-dependent) and a
        // promote (which renames MTC-*→ATC-*) re-sorts predictably — the screen re-selects the
        // promoted case by name afterwards, keeping navigation oriented.
        const files = (await readdir(join(dir, "testcases")))
          .filter((f) => f.endsWith(".md"))
          .sort((a, b) => a.localeCompare(b));
        for (const f of files) {
          try {
            cases.push({ name: f, text: await readFile(join(dir, "testcases", f), "utf8") });
          } catch {
            // skip an unreadable case file
          }
        }
      } catch {
        // no testcases/ dir
      }
      const report = await readFile(join(dir, "report.md"), "utf8").catch(() => "(no report.md)");
      const log = await readFile(join(dir, "run.log"), "utf8").catch(() => "(no run.log)");
      if (!cancelled) setState({ cases, report, log, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [dir, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
