/**
 * C1-04 — the `api` modality.
 *
 * API-1 (#22): register the command and ingest an OpenAPI v3 spec into the internal model.
 * API-2 (#132): from that model, generate one nominal happy-path case per operation and print them.
 * API-3 (#133): with `--base-url`, execute those cases (auth from config + api-scope knowledge),
 *   assert status + response-schema per case, and capture request/response evidence to disk.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ingestOpenApi, type ApiModel } from "../../api/openapi.js";
import { generateApiCases, type ApiCase } from "../../api/cases.js";
import { runApiCases, type ApiCaseResult } from "../../api/runner.js";
import { loadApiCreds } from "../../knowledge/index.js";
import { defaultRunsBaseDir } from "../../fs/run-dir.js";
import { renderRunSummary } from "../../agent/summary.js";
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

/** Render the generated baseline cases — the verifiable artifact of API-2. */
export function renderApiCases(cases: ApiCase[]): string[] {
  const lines = [
    "",
    "=== Baseline cases (happy-path · 1 per operation) ===",
    `${cases.length} case(s) generated`,
  ];
  for (const c of cases) {
    lines.push(`  ▸ ${c.name} → ${c.expectedStatus}`);
    const sent: Record<string, unknown> = {};
    for (const [where, vals] of Object.entries(c.params)) {
      if (Object.keys(vals as object).length) sent[where] = vals;
    }
    if (c.body !== undefined) sent.body = c.body;
    if (Object.keys(sent).length) lines.push(`      ${JSON.stringify(sent)}`);
  }
  lines.push("");
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
    const cases = generateApiCases(model);
    for (const line of renderApiCases(cases)) ctx.out(`${line}\n`);

    // API-3: without --base-url we stop at the generated cases (API-1/2 behaviour, unchanged).
    if (!opts.baseUrl) {
      ctx.out("Note: cases only. Pass --base-url <url> to execute them and assert responses (API-3).\n");
      return;
    }

    // Auth/headers: api-scope knowledge (#92) as the base, config --header flags on top (config wins).
    const knowledgeDir = resolve(opts.knowledgeDir ?? "knowledge");
    const fromKnowledge = await loadApiCreds(knowledgeDir, { scope: "api", endpoint: opts.baseUrl });
    const headers = { ...fromKnowledge, ...parseHeaderFlags(opts.header) };

    ctx.err(`▸ Running ${cases.length} case(s) against ${opts.baseUrl}…\n`);
    const results = await runApiCases(cases, { baseUrl: opts.baseUrl, auth: { headers } });

    const outDir = opts.out ? resolve(opts.out) : join(defaultRunsBaseDir(), `api-${randomUUID()}`);
    await mkdir(outDir, { recursive: true });
    const evidencePath = join(outDir, "api-evidence.json");
    await writeFile(evidencePath, JSON.stringify(results, null, 2), "utf8");

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
        },
        null,
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
      }),
      "utf8",
    );

    for (const line of renderApiRun(results)) ctx.out(`${line}\n`);
    for (const line of renderRunSummary({
      runDir: outDir,
      api: { passed, total: results.length, endpointCount: model.endpoints.length, evidencePath },
    })) {
      ctx.out(`${line}\n`);
    }
    if (results.some((r) => !r.passed)) process.exitCode = 1; // any failed assertion → non-zero exit
  },
};
