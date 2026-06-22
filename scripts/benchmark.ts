/**
 * Reproducible cost benchmark across the routing presets (L1-03, #8) — the side-effectful shell.
 *
 * Runs `cairn explore` (via the public {@link runExploration} API) against a FIXED target once per
 * preset — default profile tiers · `volume` (OpenRouter worker) · `fast` (Groq worker) — measures
 * wall-clock time, then READS that run's report.json for the per-role + total tokens and $ already
 * priced by the cost ledger (L1-01). It re-prices nothing; the pure mapping lives in benchmark-core.ts.
 *
 *   npm run bench                                   # all presets vs https://example.com (no session)
 *   npm run bench -- --url <u> --session <name>     # against a captured login-gated session (#27)
 *   npm run bench -- --url <u> --session-file <p>   # against a storageState file directly
 *   npm run bench -- --write                        # rewrite the docs/cost.md BENCHMARK section in place
 *   npm run bench -- --profile openrouter           # pin a different LLM_PROFILE (default: anthropic baseline)
 *   npm run bench -- --max-repair 2                 # include self-repair cost (default: 0 — faster + comparable)
 *
 * Robustness: a preset whose provider key (ANTHROPIC_API_KEY / OPENROUTER_API_KEY / GROQ_API_KEY)
 * is missing is SKIPPED and marked "n/a — <key> not set"; a run that throws is caught per-preset —
 * neither aborts the others. Dev-only tooling: it lives in scripts/ (excluded from the shipped dist/).
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config/index.js";
import {
  PRESETS,
  missingKeys,
  skippedRow,
  rowFromReport,
  renderBenchmarkTable,
  rewriteBetweenMarkers,
  type BenchReport,
  type BenchRow,
} from "./benchmark-core.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => process.argv.includes(name);

const url = arg("--url") ?? "https://example.com";
const sessionName = arg("--session");
const sessionFile = arg("--session-file");
const write = hasFlag("--write");
// The BENCHMARK markers live in docs/cost.md (README links to it); --readme overrides the target.
const benchDocPath = arg("--readme") ?? "docs/cost.md";
// Pinned for reproducibility — the bench must NOT inherit the ambient .env profile, or "default"
// would mean different models on different machines. Default profile = the documented Anthropic
// baseline (so the reasoner is Opus in every preset, matching the routing docs). MAX_REPAIR=0 keeps
// the cost comparable (repair is a variable tax) and the run ~3× faster. Both overridable.
const profile = arg("--profile") ?? "anthropic";
const maxRepair = arg("--max-repair") ?? "0";

/** Short commit of the snapshot, for the README provenance line. */
function shortCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Snapshot date (YYYY-MM-DD). Date.now()/new Date() are fine here — this is a normal Node script. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const rows: BenchRow[] = [];

for (const spec of PRESETS) {
  const missing = missingKeys(spec, process.env);
  if (missing.length > 0) {
    console.log(`• ${spec.name}: skipped — ${missing.join(", ")} not set`);
    rows.push(skippedRow(spec, `${missing.join(", ")} not set`));
    continue;
  }
  try {
    const env: Record<string, string | undefined> = { ...process.env };
    env.LLM_PROFILE = profile; // pin so "default" is reproducible, not env-dependent
    env.MAX_REPAIR = maxRepair; // pin so cost is comparable across presets/runs
    if (spec.routing) env.LLM_ROUTING = spec.routing;
    else delete env.LLM_ROUTING; // don't let a shell LLM_ROUTING leak into the default preset
    const config = loadConfig(env);
    // Lazy-load the heavy agent graph only when a preset actually runs (an all-skipped bench stays fast).
    const { runExploration } = await import("../src/index.js");
    console.log(`• ${spec.name}: exploring ${url} …`);
    const t0 = Date.now();
    const result = await runExploration({
      url,
      config,
      sessionName,
      sessionFile,
      onProgress: (e) => console.log(`    ${spec.name} ▸ ${e}`),
    });
    const wallMs = Date.now() - t0;
    const report = JSON.parse(await readFile(join(result.runDir, "report.json"), "utf8")) as BenchReport;
    rows.push(rowFromReport(spec, report, wallMs));
    console.log(
      `  ✓ ${spec.name}: ${report.cost.totalTokens.toLocaleString("en-US")} tokens · ${(wallMs / 1000).toFixed(1)}s · run ${result.runId}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${spec.name}: run failed — ${msg}`);
    rows.push(skippedRow(spec, `run failed: ${msg}`));
  }
}

const block = renderBenchmarkTable(rows, {
  date: today(),
  commit: shortCommit(),
  url,
  session: sessionName,
  profile,
  maxRepair: Number(maxRepair),
});

console.log(`\n${block}\n`);

if (write) {
  const doc = await readFile(benchDocPath, "utf8");
  await writeFile(benchDocPath, rewriteBetweenMarkers(doc, block), "utf8");
  console.log(`✓ Updated ${benchDocPath} between the BENCHMARK markers.`);
} else {
  console.log(`(dry run — pass --write to update ${benchDocPath} between the BENCHMARK markers)`);
}
