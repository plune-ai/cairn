/**
 * C1-04 — the `api` modality.
 *
 * API-1 (#22): register the command and ingest an OpenAPI v3 spec into the internal model.
 * API-2 (#132): from that model, generate one nominal happy-path case per operation and print them.
 * API-3 (#133): with `--base-url`, execute those cases (auth from config + api-scope knowledge),
 *   assert status + response-schema per case, and capture request/response evidence to disk.
 * API-8 (#145): with `--negative`, also generate/run one negative-schema (contract-violation) case
 *   per operation, alongside the happy-path case — same pipeline, distinct `type: "Negative"`.
 * API-9 (#146): with `--scenarios`, also generate/run multi-endpoint chains on the same resource
 *   (e.g. create → read → delete), threading a captured response value through each step.
 * BORROW-07 (#95): with `--adversarial`, also generate/run cases in one or more named styles —
 *   normal/curious/psycho/hacker (`src/api/adversarial.ts`) — alongside the existing cases.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ingestOpenApi, type ApiModel } from "../../api/openapi.js";
import { generateApiCases, generateNegativeCases, type ApiCase } from "../../api/cases.js";
import { generateAdversarialCases, ADVERSARIAL_STYLES, type AdversarialStyle } from "../../api/adversarial.js";
import { runApiCases, type ApiCaseResult, type RunnerOptions } from "../../api/runner.js";
import { generateApiScenarios, type ApiScenario } from "../../api/scenarios.js";
import { runApiScenarios, type ApiScenarioResult } from "../../api/scenario-runner.js";
import { buildApiTestCaseDocs } from "../../api/testcase-docs.js";
import { computeApiCoverage, type ApiCoverageReport } from "../../api/coverage.js";
import { loadApiCreds } from "../../knowledge/index.js";
import { defaultRunsBaseDir } from "../../fs/run-dir.js";
import { renderRunSummary, displayPath } from "../../agent/summary.js";
import { renderApiReportMd } from "../../artifacts/report.js";
import type { Modality, ModalityContext } from "../modality.js";

/** Parsed flags for `cairn api` (mirrors the command's option definitions). */
interface ApiFlags {
  spec?: string;
  /** API-3: configured base URL to run cases against. Absent → ingest + generate only (API-1/2). */
  baseUrl?: string;
  /** API-3: extra request headers `Name: Value` (repeatable); override knowledge-supplied headers. */
  header?: string[];
  /** API-3: where to write run evidence (default runs/api-<id>/). */
  out?: string;
  /** API-3: knowledge dir for api-scope auth/headers (#92). Default `knowledge`. */
  knowledgeDir?: string;
  /** API-8: also generate/run one negative-schema (contract-violation) case per operation. */
  negative?: boolean;
  /** API-9: also generate/run multi-endpoint scenario chains (e.g. create → read → delete). */
  scenarios?: boolean;
  /** BORROW-07 (#95): also generate/run adversarial-style cases. `true` (bare flag) = all four
   * styles; a comma-separated string picks specific ones. */
  adversarial?: boolean | string;
}

/**
 * Parse `--adversarial` into the requested style list. A bare flag means all four; a comma-separated
 * value picks specific styles. Unrecognised names are dropped, NOT a signal to fall back to "all" —
 * a typo should generate fewer cases than intended, never silently more.
 */
function parseAdversarialFlag(flag: boolean | string | undefined): AdversarialStyle[] {
  if (!flag) return [];
  if (flag === true) return [...ADVERSARIAL_STYLES];
  return flag
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AdversarialStyle => (ADVERSARIAL_STYLES as readonly string[]).includes(s));
}

/** Parse repeated `--header "Name: Value"` flags into a header map (config auth). */
function parseHeaderFlags(flags: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of flags ?? []) {
    const i = h.indexOf(":");
    if (i > 0) out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

/**
 * Render the runner's per-case verdicts — the verifiable artifact of API-3. The aggregate
 * pass/fail + coverage + evidence-path footer is API-4's `renderRunSummary` (shared with web runs).
 */
export function renderApiRun(results: ApiCaseResult[]): string[] {
  const passed = results.filter((r) => r.passed).length;
  const lines = ["", "=== Run results (status + schema asserts) ===", `${passed}/${results.length} case(s) passed`];
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    const got = r.error ? `error: ${r.error}` : `${r.response?.status ?? "—"} (want ${r.expectedStatus})`;
    const retries = r.attempts > 1 ? ` ·${r.attempts} attempts` : "";
    lines.push(`  ${mark} ${r.name} → ${got}${retries}`);
    if (!r.statusOk && !r.error) lines.push(`      status mismatch`);
    for (const e of r.schemaErrors) lines.push(`      schema: ${e}`);
  }
  return lines;
}

/** Is this a remote spec we hand to swagger-parser as-is, vs a local file path we resolve? */
function isUrl(spec: string): boolean {
  return /^https?:\/\//i.test(spec);
}

/** ATC id suite for this run's cases — mirrors web's `suiteFromUrl` (`agent/index.ts`). */
function suiteFromApi(model: ApiModel, source: string): string {
  const base = model.title ?? basename(source).replace(/\.[^.]+$/, "");
  return `${base.replace(/[^a-z0-9]+/gi, "-").toUpperCase()}-API`;
}

/** Drop `expectedSchema` — a raw (possibly cyclic) pointer into the dereferenced spec, not JSON-safe. */
function omitExpectedSchema(c: ApiCase): Omit<ApiCase, "expectedSchema"> {
  const rest: Partial<ApiCase> = { ...c };
  delete rest.expectedSchema;
  return rest as Omit<ApiCase, "expectedSchema">;
}

/**
 * `JSON.stringify` replacer (API-10, #150): a `format: binary` property synthesises to a real
 * `Buffer` (so the runner can send actual file bytes) — but a raw byte-array dump is noise in a
 * rendered/persisted artifact (CLI preview, `api-evidence.json`, `report.json`). `Buffer` already
 * ran through its own `toJSON()` (`{ type: "Buffer", data: [...] }`) by the time a replacer sees it,
 * which is the shape this recognises and swaps for a short marker.
 */
function jsonSafe(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) {
    return `<binary ${(value as { data: unknown[] }).data.length}b>`;
  }
  return value;
}

/** Print the parsed-model summary — the verifiable artifact of this slice. */
export function renderApiSummary(model: ApiModel, source: string): string[] {
  const lines = [
    `=== API spec: ${model.title ?? "(untitled)"}${model.version ? ` v${model.version}` : ""} (OpenAPI ${model.openapiVersion}) ===`,
    `Source: ${source}`,
    `${model.endpoints.length} endpoint(s) across ${model.tags.length} tag(s)` +
      (model.securitySchemes.length ? ` · ${model.securitySchemes.length} security scheme(s)` : ""),
  ];
  if (model.tags.length) lines.push(`Tags: ${model.tags.join(", ")}`);
  for (const e of model.endpoints) {
    const op = e.operationId ? ` (${e.operationId})` : "";
    const tag = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
    lines.push(`  ${e.method.padEnd(6)} ${e.path}${op}${tag}`);
  }
  return lines;
}

/** Render the generated cases — the verifiable artifact of API-2 (+ API-8 negative cases, if requested). */
export function renderApiCases(cases: ApiCase[]): string[] {
  const negative = cases.filter((c) => c.type === "Negative").length;
  // "normal"-tagged cases ARE the baseline happy path (tagged in place, not additional) — only
  // curious/psycho/hacker are genuinely extra cases worth calling out in the summary count.
  const adversarial = cases.filter((c) => c.adversarialStyle && c.adversarialStyle !== "normal").length;
  const lines = [
    "",
    "=== Baseline cases (happy-path · 1 per operation) ===",
    `${cases.length} case(s) generated${negative ? ` (${negative} negative-schema)` : ""}${adversarial ? ` (${adversarial} adversarial)` : ""}`,
  ];
  for (const c of cases) {
    const style = c.adversarialStyle ? `[${c.adversarialStyle}${c.wstgId ? ` ${c.wstgId}` : ""}] ` : "";
    lines.push(`  ▸ ${c.name} ${style}[${c.type}] → ${c.expectedStatus}`);
    lines.push(`      [${c.technique}] ${c.rationale}`);
    const sent: Record<string, unknown> = {};
    for (const [where, vals] of Object.entries(c.params)) {
      if (Object.keys(vals as object).length) sent[where] = vals;
    }
    if (c.body !== undefined) sent.body = c.body;
    if (Object.keys(sent).length) lines.push(`      ${JSON.stringify(sent, jsonSafe)}`);
  }
  lines.push("");
  return lines;
}

/** Render the generated scenario chains (API-9, #146) — a cases-only preview when there's no run yet. */
export function renderApiScenarios(scenarios: ApiScenario[]): string[] {
  if (scenarios.length === 0) return [];
  const lines = ["", `=== Scenarios (${scenarios.length} chain(s) generated) ===`];
  for (const s of scenarios) {
    lines.push(`  ▸ ${s.name} (${s.steps.map((c) => c.name).join(" → ")})`);
    lines.push(`      [${s.technique}] ${s.rationale}`);
  }
  lines.push("");
  return lines;
}

/** Render scenario run results — per-scenario pass/fail + per-step breakdown (API-9 DoD). */
export function renderApiScenarioRun(results: ApiScenarioResult[]): string[] {
  if (results.length === 0) return [];
  const passed = results.filter((r) => r.passed).length;
  const lines = ["", "=== Scenario results ===", `${passed}/${results.length} scenario(s) passed`];
  for (const r of results) {
    lines.push(`  ${r.passed ? "✓" : "✗"} ${r.name}`);
    for (const step of r.steps) {
      const mark = step.passed ? "✓" : step.error?.startsWith("skipped") ? "⊘" : "✗";
      const got = step.error ? `${step.error}` : `${step.response?.status ?? "—"} (want ${step.expectedStatus})`;
      lines.push(`      ${mark} ${step.name} → ${got}`);
    }
  }
  return lines;
}

/**
 * Render the spec-vs-tested coverage report (API-6, #136, `playswag`-style) — a summary line plus
 * gaps only (uncovered/partial); fully-covered operations need no per-row listing.
 */
export function renderApiCoverage(coverage: ApiCoverageReport): string[] {
  const lines = [
    "",
    `=== Coverage (${coverage.coveredCount}/${coverage.endpointCount} endpoint(s) — ${Math.round(coverage.ratio * 100)}%) ===`,
  ];
  if (coverage.partialCount) lines.push(`  ${coverage.partialCount} partially covered`);
  if (coverage.uncoveredCount) lines.push(`  ${coverage.uncoveredCount} uncovered`);
  for (const e of coverage.endpoints) {
    if (e.status === "covered") continue;
    const mark = e.status === "partial" ? "⚠" : "✗";
    const op = e.operationId ? ` (${e.operationId})` : "";
    const dep = e.deprecated ? " [deprecated]" : "";
    const tested = e.testedStatuses.length ? e.testedStatuses.join(", ") : "—";
    const missing = e.declaredStatuses.filter((s) => !e.testedStatuses.includes(s)).join(", ");
    lines.push(
      `  ${mark} ${e.status.padEnd(9)} ${e.method.padEnd(6)} ${e.path}${op}${dep} — tested: ${tested}${missing ? ` · missing: ${missing}` : ""}`,
    );
  }
  return lines;
}

export const apiModality: Modality = {
  name: "api",
  gated: false,
  summary: "Generate API / contract tests from an OpenAPI spec",
  async run(ctx: ModalityContext): Promise<void> {
    const opts = ctx.flags as ApiFlags;
    const spec = opts.spec;
    if (!spec) {
      // commander enforces requiredOption in the CLI; this guards programmatic/test callers.
      throw new Error("`cairn api` requires --spec <path|url> (an OpenAPI 3.x JSON/YAML spec).");
    }
    const source = isUrl(spec) ? spec : resolve(spec);
    ctx.err(`▸ Ingesting OpenAPI spec from ${source}…\n`);
    let model: ApiModel;
    try {
      model = await ingestOpenApi(source);
    } catch (e) {
      // Clean, non-crashing failure (acceptance): clear message, exit non-zero.
      ctx.err(`✗ ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    for (const line of renderApiSummary(model, source)) ctx.out(`${line}\n`);
    // BORROW-07 (#95): "normal" style is the always-generated happy path itself — tag in place rather
    // than re-emitting duplicate cases when both are on (e.g. bare `--adversarial`).
    const adversarialStyles = parseAdversarialFlag(opts.adversarial);
    const baseCases = generateApiCases(model);
    const taggedBaseCases = adversarialStyles.includes("normal")
      ? baseCases.map((c): ApiCase => ({ ...c, adversarialStyle: "normal" }))
      : baseCases;
    const cases = [
      ...taggedBaseCases,
      ...(opts.negative ? generateNegativeCases(model) : []),
      ...generateAdversarialCases(model, adversarialStyles),
    ];
    for (const line of renderApiCases(cases)) ctx.out(`${line}\n`);
    const scenarios = opts.scenarios ? generateApiScenarios(model) : [];
    for (const line of renderApiScenarios(scenarios)) ctx.out(`${line}\n`);

    // API-3: without --base-url we stop at the generated cases (API-1/2 behaviour, unchanged).
    if (!opts.baseUrl) {
      // API-6 (#136): coverage is meaningful even without a run — it's spec-vs-generated-cases.
      for (const line of renderApiCoverage(computeApiCoverage(model, cases))) ctx.out(`${line}\n`);
      ctx.out("Note: cases only. Pass --base-url <url> to execute them and assert responses (API-3).\n");
      return;
    }

    // Auth/headers: api-scope knowledge (#92) as the base, config --header flags on top (config wins).
    const knowledgeDir = resolve(opts.knowledgeDir ?? "knowledge");
    const fromKnowledge = await loadApiCreds(knowledgeDir, { scope: "api", endpoint: opts.baseUrl });
    const headers = { ...fromKnowledge, ...parseHeaderFlags(opts.header) };

    const runnerOpts: RunnerOptions = { baseUrl: opts.baseUrl, auth: { headers } };
    ctx.err(`▸ Running ${cases.length} case(s) against ${opts.baseUrl}…\n`);
    const results = await runApiCases(cases, runnerOpts);
    // API-6 (#136): spec-vs-tested coverage, overlaid with this run's pass/fail per operation.
    const coverage = computeApiCoverage(model, cases, results);

    // API-9 (#146): scenario chains run after the per-operation cases — independent of them.
    const scenarioResults = scenarios.length ? await runApiScenarios(scenarios, runnerOpts) : [];

    const outDir = opts.out ? resolve(opts.out) : join(defaultRunsBaseDir(), `api-${randomUUID()}`);
    await mkdir(outDir, { recursive: true });
    const evidencePath = join(outDir, "api-evidence.json");
    await writeFile(evidencePath, JSON.stringify(results, jsonSafe, 2), "utf8");

    // API-4 (#134): report.json/report.md in the same shape/location the run summary and the TUI's
    // past-run browser already read for web runs — no parallel reporting layer.
    const passed = results.filter((r) => r.passed).length;
    const runId = basename(outDir);
    await writeFile(
      join(outDir, "report.json"),
      JSON.stringify(
        {
          runId,
          url: opts.baseUrl,
          mode: "api",
          api: { passed, total: results.length, endpointCount: model.endpoints.length },
          // API-5 (#135): methodology-tagged cases (technique + rationale) — the Plune-record payload.
          // `expectedSchema` is dropped: it's a raw pointer into the (possibly cyclic, e.g. `Pet.friends:
          // Pet[]`) dereferenced spec schema, not serialisable — the case's own contract is enough here.
          cases: cases.map((c) => omitExpectedSchema(c)),
          // API-6 (#136): spec-vs-tested coverage (playswag-style) — which operations/statuses are gaps.
          coverage,
          // API-9 (#146): per-scenario pass/fail alongside the per-operation results — opt-in, so the
          // key is only present when --scenarios generated something to report.
          ...(scenarioResults.length ? { scenarios: scenarioResults } : {}),
        },
        jsonSafe,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(outDir, "report.md"),
      renderApiReportMd({
        runId,
        baseUrl: opts.baseUrl,
        source,
        results,
        endpointCount: model.endpoints.length,
        evidencePath,
        coverage,
        scenarios: scenarioResults,
      }),
      "utf8",
    );

    // API-5 (#135): emit the same ATC artifact boundary web runs write (`testcases/<id>.md`) so Plune
    // ingests API cases identically — each doc carries the technique/rationale tag and a
    // provenance-checked status (only "Passed" when a matching, positively-asserted result exists).
    const suite = suiteFromApi(model, source);
    const caseDocs = buildApiTestCaseDocs(cases, results, suite);
    const testCasesDir = join(outDir, "testcases");
    await mkdir(testCasesDir, { recursive: true });
    for (const d of caseDocs.docs) await writeFile(join(testCasesDir, `${d.id}.md`), d.md, "utf8");

    for (const line of renderApiRun(results)) ctx.out(`${line}\n`);
    for (const line of renderApiScenarioRun(scenarioResults)) ctx.out(`${line}\n`);
    for (const line of renderApiCoverage(coverage)) ctx.out(`${line}\n`);
    for (const line of renderRunSummary({
      runDir: outDir,
      api: { passed, total: results.length, endpointCount: model.endpoints.length, evidencePath },
    })) {
      ctx.out(`${line}\n`);
    }
    ctx.out(`  Cases (ATC .md): ${displayPath(testCasesDir)}/\n`);
    // Any failed assertion (per-operation case or scenario step) → non-zero exit.
    if (results.some((r) => !r.passed) || scenarioResults.some((r) => !r.passed)) process.exitCode = 1;
  },
};
