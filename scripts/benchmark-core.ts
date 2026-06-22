/**
 * Cost-benchmark pure core (L1-03, #8). NO I/O, NO network, NO SDK — every function here is a
 * deterministic transform so it can be unit-tested with fixture report.json objects and added to
 * the coverage gate. The side-effectful orchestration (running `cairn explore`, reading
 * report.json, git, rewriting docs/cost.md) lives in the sibling `benchmark.ts` shell.
 *
 * Reuses the existing cost ledger: the benchmark READS the `cost` block already written into every
 * run's report.json (per-role + totals, L1-01/ADR-0011) — it never re-prices or re-counts tokens.
 */
import type { CostReport } from "../src/llm/cost.js";

/** docs/cost.md section fences — the script rewrites only what sits between them. */
export const BENCH_START = "<!-- BENCHMARK:START -->";
export const BENCH_END = "<!-- BENCHMARK:END -->";

/**
 * One routing preset to benchmark. `routing` is the `--routing`/`LLM_ROUTING` value (undefined for
 * the profile-default preset). `requiredKeys` are the provider env vars that must all be present, or
 * the preset is skipped (loadConfig would otherwise throw). `models` are the DOCUMENTED defaults,
 * shown for a skipped row (an actual run reports the real models it used instead).
 */
export interface PresetSpec {
  name: string;
  routing?: string;
  requiredKeys: string[];
  models: { worker: string; reasoner: string };
}

/**
 * The three presets (#7 landed `fast`): default profile tiers · `volume` (OpenRouter worker) ·
 * `fast` (Groq worker). In every preset the reasoner stays on Anthropic Opus (ADR-0011), so each
 * non-default preset needs ANTHROPIC_API_KEY in addition to its worker-provider key.
 */
export const PRESETS: PresetSpec[] = [
  {
    name: "default",
    routing: undefined,
    requiredKeys: ["ANTHROPIC_API_KEY"],
    models: { worker: "claude-sonnet-4-6", reasoner: "claude-opus-4-8" },
  },
  {
    name: "volume",
    routing: "volume",
    requiredKeys: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"],
    models: { worker: "deepseek/deepseek-chat", reasoner: "claude-opus-4-8" },
  },
  {
    name: "fast",
    routing: "fast",
    requiredKeys: ["GROQ_API_KEY", "ANTHROPIC_API_KEY"],
    models: { worker: "llama-3.3-70b-versatile", reasoner: "claude-opus-4-8" },
  },
];

/** The only part of a run's report.json the benchmark consumes. */
export interface BenchReport {
  cost: CostReport;
}

/** One rendered table row. `null` metrics render as an em-dash; a skipped row carries a `note`. */
export interface BenchRow {
  preset: string;
  status: "ok" | "skipped";
  note?: string;
  worker: string;
  reasoner: string;
  tokens: number | null;
  costUsd: number | null;
  seconds: number | null;
  costPerHourUsd: number | null;
}

/** Snapshot metadata stamped into the rendered section (kept out of the pure core's control flow). */
export interface BenchMeta {
  date: string;
  commit: string;
  url: string;
  session?: string;
  /** Pinned LLM_PROFILE the bench ran under — makes "default" reproducible, not env-dependent. */
  profile: string;
  /** Pinned MAX_REPAIR — recorded so the cost is interpretable (repair is a variable cost tax). */
  maxRepair: number;
}

/** Pure: which of a preset's required env keys are absent? Empty-string counts as absent. */
export function missingKeys(spec: PresetSpec, env: Record<string, string | undefined>): string[] {
  return spec.requiredKeys.filter((k) => !env[k]);
}

/**
 * Pure: the CLEARLY-LABELLED extrapolation — `$/run × (3600 / seconds)`, i.e. the cost if runs
 * fired back-to-back for an hour (NOT a steady-state claim). Null when cost is unknown or seconds
 * is missing/non-positive (avoids a divide-by-zero blow-up).
 */
export function costPerHour(costUsd: number | null, seconds: number | null): number | null {
  if (costUsd == null || seconds == null || seconds <= 0) return null;
  return costUsd * (3600 / seconds);
}

/** Pure: a skipped preset (missing key / failed run) → an n/a row. Never throws. */
export function skippedRow(spec: PresetSpec, note: string): BenchRow {
  return {
    preset: spec.name,
    status: "skipped",
    note,
    worker: spec.models.worker,
    reasoner: spec.models.reasoner,
    tokens: null,
    costUsd: null,
    seconds: null,
    costPerHourUsd: null,
  };
}

/** Pure: map a run's report.json cost block + measured wall-clock (ms) → a benchmark row. */
export function rowFromReport(spec: PresetSpec, report: BenchReport, wallMs: number): BenchRow {
  const perRole = report.cost.perRole;
  const modelsFor = (role: string, fallback: string): string => {
    const r = perRole.find((x) => x.role === role);
    return r && r.models.length > 0 ? r.models.join("+") : fallback;
  };
  const seconds = wallMs / 1000;
  const costUsd = report.cost.totalCostUsd;
  return {
    preset: spec.name,
    status: "ok",
    worker: modelsFor("worker", spec.models.worker),
    reasoner: modelsFor("reasoner", spec.models.reasoner),
    tokens: report.cost.totalTokens,
    costUsd,
    seconds,
    costPerHourUsd: costPerHour(costUsd, seconds),
  };
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  // Sub-dollar values (typical $/run) need more precision than dollar-plus values ($/hour).
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtTokens(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

function fmtSeconds(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}s`;
}

/**
 * Collapse whitespace (incl. newlines — a raw newline would split the table row and corrupt the
 * markdown) and clip to `max` so a long failure message stays one compact, readable cell.
 */
function clipNote(note: string, max = 80): string {
  const oneLine = note.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function renderRow(r: BenchRow): string {
  if (r.status === "skipped") {
    return `| \`${r.preset}\` | ${r.worker} | ${r.reasoner} | n/a — ${clipNote(r.note ?? "skipped")} | — | — | — |`;
  }
  return `| \`${r.preset}\` | ${r.worker} | ${r.reasoner} | ${fmtTokens(r.tokens)} | ${fmtUsd(r.costUsd)} | ${fmtSeconds(r.seconds)} | ${fmtUsd(r.costPerHourUsd)} |`;
}

/**
 * Pure: render the full markdown block that lives between the BENCHMARK markers — the table, the
 * $/hour extrapolation assumption, a reproduce command, the snapshot date/commit/target, and the
 * standing movable-prices caveat (ADR-0002).
 */
export function renderBenchmarkTable(rows: BenchRow[], meta: BenchMeta): string {
  const target = meta.session ? `\`${meta.url}\` (session \`${meta.session}\`)` : `\`${meta.url}\` (no session)`;
  return [
    "<!-- Generated by `npm run bench` — do not edit between the BENCHMARK markers by hand. -->",
    "",
    `_Snapshot: ${meta.date} · commit \`${meta.commit}\` · profile \`${meta.profile}\` · MAX_REPAIR=${meta.maxRepair} · target: ${target} · approximate, single-run._`,
    "",
    "| Preset | Worker | Reasoner | Tokens/run | $/run | Wall-clock/run | $/hour† |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(renderRow),
    "",
    "† **$/hour is an extrapolation**, not a steady-state rate: `$/run × (3600 / seconds-per-run)` — the cost if runs fired back-to-back for an hour. Real throughput varies with target complexity, retries, and provider latency.",
    "",
    `Reproduce: \`npm run bench -- --url ${meta.url} --session <name>\``,
    "",
    "> Token counts vary run-to-run (LLM nondeterminism). OpenRouter/Groq prices are approximate and movable ([ADR-0002](adr/0002-llm-anthropic-tiering.md)); Anthropic prices follow the published rates. `$/run` is `—` when a model has no configured price (tokens are still counted).",
  ].join("\n");
}

/**
 * Pure + idempotent: replace the content between `start` and `end` with `block`, leaving everything
 * else untouched. Throws if the markers are missing or reversed — docs/cost.md must own the fences.
 */
export function rewriteBetweenMarkers(
  content: string,
  block: string,
  start: string = BENCH_START,
  end: string = BENCH_END,
): string {
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(`Benchmark markers not found or reversed (expected "${start}" … "${end}").`);
  }
  const before = content.slice(0, s + start.length);
  const after = content.slice(e);
  return `${before}\n${block}\n${after}`;
}
