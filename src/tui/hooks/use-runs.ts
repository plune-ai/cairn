import { useEffect, useState } from "react";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { RunSummary } from "../types.js";

export interface RunsState {
  runs: RunSummary[];
  loading: boolean;
  error?: string;
}

interface ReportShape {
  url?: string;
  mode?: string;
  validation?: { greenRatio?: number };
  pilot?: { verdict?: "pass" | "needs-work" | "fail" };
  testCases?: unknown[];
  /** C1-04 / API-4 (#134): present when `mode === "api"`. */
  api?: { passed?: number; total?: number; endpointCount?: number };
}

/**
 * Scans ./runs, reading ONLY each report.json (skips the heavy study.json) to build a
 * sorted RunSummary[]. The date comes from report.json's mtime (run IDs are timestamp-less UUIDs).
 */
export function useRuns(baseDir = "runs"): RunsState & { reload: () => void } {
  const [state, setState] = useState<RunsState>({ runs: [], loading: true });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const base = resolve(baseDir);
        const entries = await readdir(base, { withFileTypes: true });
        const runs: RunSummary[] = [];
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const dir = join(base, e.name);
          const reportPath = join(dir, "report.json");
          try {
            const rep = JSON.parse(await readFile(reportPath, "utf8")) as ReportShape;
            const st = await stat(reportPath);
            runs.push({
              runId: e.name,
              dir,
              url: rep.url ?? "(unknown url)",
              mode: rep.mode === "design" ? "design" : rep.mode === "api" ? "api" : "explore",
              greenRatio: rep.validation?.greenRatio,
              pilot: rep.pilot?.verdict,
              testCaseCount: rep.testCases?.length ?? 0,
              date: st.mtime,
              ...(rep.mode === "api"
                ? { api: { passed: rep.api?.passed ?? 0, total: rep.api?.total ?? 0, endpointCount: rep.api?.endpointCount ?? 0 } }
                : {}),
            });
          } catch {
            // no readable report.json → not a finished run, skip
          }
        }
        runs.sort((a, b) => b.date.getTime() - a.date.getTime());
        if (!cancelled) setState({ runs, loading: false });
      } catch (err) {
        if (!cancelled) {
          setState({ runs: [], loading: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseDir, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
