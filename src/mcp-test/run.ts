/**
 * MCP-E1 — `cairn mcp-test`: connect to a server, read it, write `mcp-model.json` and a short summary.
 * No case is generated and no tool is called here.
 *
 * Exit codes: 0 read; 1 the server could not be reached or read (did not start, did not answer `initialize`, wants
 * authentication, spoke something else); 5 it was read but offers no tool - nothing to test, which is not "all well".
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parsePositiveInt, parsePositiveNumber, parseBaseUrl, tooShortSecrets } from "../api/guard.js";
import { parseMinCoverage } from "../api/coverage.js";
import { buildSecrets, maskSecrets, maskStrings } from "./secrets.js";
import { defaultRunsBaseDir } from "../fs/run-dir.js";
import { connectMcp, McpTestError, type McpConnection } from "./connect.js";
import { DEFAULT_MAX_LIST_ENTRIES, DEFAULT_MAX_LIST_PAGES, discoverModel } from "./discover.js";
import { MCP_ADVERSARIAL_STYLES, parseAdversarialStyles, resolveLimits } from "./adversarial.js";
import { buildEvidence, buildMcpTestCaseDocs, buildReportJson, countStates, mcpExitCode, NOTHING_PROVEN_EXIT_CODE, renderMcpReportMd, settle, type Finding } from "./report.js";
import { computeMcpCoverage, evaluateMcpGate, renderMcpCoverage } from "./coverage.js";
import { type CaseResult, type Link, type RunnableCase, runAnonymousProbe, runCases } from "./runner.js";
import { discoverTools } from "./discover.js";
import { CASES_FILE, DEFAULT_MAX_CASES_PER_TOOL, dropMaskedCases, generateMcpCases, renderCasesSummary } from "./cases.js";
import { canonicalModel, renderModelSummary, safeText, serializeCanonical, sortKeys, type McpModel } from "./model.js";
import {
  DEFAULT_CALL_RPS,
  DEFAULT_MAX_CALLS,
  McpCallGuard,
  assessTools,
  parseAllowTools,
  renderGuardReport,
  renderMismatches,
  renderProposal,
  unknownToolNames,
} from "./guard.js";

export const NOTHING_TO_TEST_EXIT_CODE = 5;
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MODEL_FILE = "mcp-model.json";
export const STDERR_FILE = "server-stderr.log";
export const GUARD_FILE = "mcp-guard.json";
export const EVIDENCE_FILE = "mcp-evidence.json";
export const REPORT_FILE = "report.json";
/** The most an `--examples` file may weigh. */
export const MAX_EXAMPLES_BYTES = 1024 * 1024;

export interface McpTestOptions {
  /** stdio: the server command and its arguments (what follows `--`). */
  command?: string[];
  /** Streamable HTTP: the server address. */
  url?: string;
  /** `Name: Value`, repeatable. */
  header?: string[];
  /** `KEY=VALUE`, repeatable. */
  env?: string[];
  cwd?: string;
  /** Seconds for one request. */
  timeout?: string | number;
  out?: string;
  maxPages?: string | number;
  maxEntries?: string | number;
  /** Call guard (MCP-E4): exact tool names, comma separated. */
  allowTools?: string;
  allowReadOnlyHints?: boolean;
  allowMutations?: boolean;
  maxCalls?: string | number;
  rps?: string | number;
  /** Seconds for one tool call. */
  callTimeout?: string | number;
  /** Seconds for the whole run of calls. */
  timeBudget?: string | number;
  /** Cases (MCP-E2): most cases kept per tool. */
  maxCasesPerTool?: string | number;
  /** Cases: a JSON file, tool name to the arguments of its valid case. */
  examples?: string;
  /** Adversarial styles (MCP-E3): `true` for all four, or a comma-separated list. Data only: nothing is sent. */
  adversarial?: boolean | string;
  adversarialMaxString?: string | number;
  adversarialMaxDepth?: string | number;
  /** A call without credentials that goes through is a failure, not a finding. */
  expectAuth?: boolean;
  /** Coverage gate: a percentage; exit code 3 when fewer tools are covered. */
  minCoverage?: string | number;
  countPartial?: boolean;
  /** The most of one answer that is kept (bytes). */
  maxResponseBytes?: string | number;
  signal?: AbortSignal;
  importer?: (specifier: string) => Promise<unknown>;
}

export interface McpTestIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface McpTestResult {
  exitCode: number;
  outDir?: string;
  model?: McpModel;
  /** The stdio server's process id, so a test can check it is gone. */
  pid: number | null;
}

function parseHeaders(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list ?? []) {
    const i = h.indexOf(":");
    if (i <= 0) throw new Error(`--header must look like "Name: Value" (got a value without a name).`);
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

function parseEnv(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of list ?? []) {
    const i = e.indexOf("=");
    if (i <= 0) throw new Error(`--env must look like KEY=VALUE (got a value without a name).`);
    out[e.slice(0, i)] = e.slice(i + 1);
  }
  return out;
}

/** A plain decimal whole number: no hex, no exponent, no sign, no spaces (`Number()` would take `0x10` and `1e3`). */
function parseDecimal(flag: string, v: string | number): number {
  const text = String(v);
  if (!/^[0-9]+$/.test(text)) throw new Error(`${flag} must be a plain decimal whole number (got "${safeText(text, 20)}").`);
  return Number(text);
}

/** Reads an `--examples` file: size limit, strict JSON, an object of tool name to an object of arguments. */
async function readExamples(path: string): Promise<Record<string, Record<string, unknown>>> {
  const file = resolve(path);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error("--examples: the file does not exist or is not a file.");
  if (info.size > MAX_EXAMPLES_BYTES) throw new Error(`--examples: the file is larger than ${MAX_EXAMPLES_BYTES} bytes.`);
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("--examples: the file is not valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error('--examples: expected an object like {"tool": {"argument": value}}.');
  for (const [name, args] of Object.entries(data)) {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`--examples: the value for "${safeText(name, 60)}" must be an object of arguments.`);
    }
  }
  return data as Record<string, Record<string, unknown>>;
}

/** The last lines of the server's stderr, safe to print. */
function stderrTail(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => safeText(l, 200))
    .filter(Boolean)
    .slice(-8)
    .map((l) => `    ${l}`);
}

export async function runMcpTest(opts: McpTestOptions, io: McpTestIO): Promise<McpTestResult> {
  const command = opts.command && opts.command.length ? opts.command : undefined;
  if ((command === undefined) === (opts.url === undefined)) {
    throw new Error("Give the server either as a command after `--` (stdio) or with --url (Streamable HTTP), not both and not neither.");
  }
  const timeoutSeconds = opts.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : parsePositiveNumber("--timeout", opts.timeout);
  const maxPages = opts.maxPages === undefined ? DEFAULT_MAX_LIST_PAGES : parsePositiveInt("--max-pages", opts.maxPages);
  const maxEntries = opts.maxEntries === undefined ? DEFAULT_MAX_LIST_ENTRIES : parsePositiveInt("--max-entries", opts.maxEntries);
  // The call guard's flags are checked before anything connects: a bad one is a usage error, never a permission.
  const allowTools = parseAllowTools(opts.allowTools);
  const maxCalls = opts.maxCalls === undefined ? DEFAULT_MAX_CALLS : parsePositiveInt("--max-calls", opts.maxCalls);
  const callRps = opts.rps === undefined ? DEFAULT_CALL_RPS : parsePositiveNumber("--rps", opts.rps, 0.01);
  const callTimeoutMs = Math.round((opts.callTimeout === undefined ? 30 : parsePositiveNumber("--call-timeout", opts.callTimeout)) * 1000);
  const minCoverage = opts.minCoverage === undefined ? undefined : parseMinCoverage(opts.minCoverage);
  const timeBudgetSeconds = opts.timeBudget === undefined ? undefined : parsePositiveNumber("--time-budget", opts.timeBudget);
  const maxCasesPerTool = opts.maxCasesPerTool === undefined ? DEFAULT_MAX_CASES_PER_TOOL : parsePositiveInt("--max-cases-per-tool", opts.maxCasesPerTool);
  const examples = opts.examples === undefined ? undefined : await readExamples(opts.examples);
  const adv = parseAdversarialStyles(opts.adversarial);
  const advLimits = resolveLimits({
    styles: adv.styles,
    ...(opts.adversarialMaxString !== undefined ? { maxStringLength: parseDecimal("--adversarial-max-string", opts.adversarialMaxString) } : {}),
    ...(opts.adversarialMaxDepth !== undefined ? { maxDepth: parseDecimal("--adversarial-max-depth", opts.adversarialMaxDepth) } : {}),
  });
  const callsRequested = allowTools.length > 0 || opts.allowReadOnlyHints === true || opts.allowMutations === true;
  const headers = parseHeaders(opts.header);
  const env = parseEnv(opts.env);
  if (command && Object.keys(headers).length) throw new Error("--header applies to --url only.");
  if (opts.url && (Object.keys(env).length || opts.cwd)) throw new Error("--env and --cwd apply to a stdio command only.");

  // Every value that could be a secret, gathered before anything is printed or written.
  const urlSecrets: string[] = [];
  let url = opts.url;
  if (url !== undefined) {
    try {
      const p = parseBaseUrl(url);
      url = p.baseUrl;
      urlSecrets.push(...p.secrets);
      if (p.basicAuth && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
        headers["Authorization"] = p.basicAuth;
      }
    } catch (e) {
      throw new Error((e as Error).message.replace(/--base-url/g, "--url"));
    }
  }
  const weak = [...tooShortSecrets(headers), ...tooShortSecrets(env)];
  if (weak.length) io.err(`⚠ The secret in ${weak.join(", ")} is shorter than 4 characters and will NOT be masked in the output.\n`);
  // One list from every source, longest first (see secrets.ts); applied before anything is shortened or printed.
  const secrets = buildSecrets(headers, env, urlSecrets);
  const mask = (s: string): string => maskSecrets(s, secrets);
  // A line that starts with `::` or `##[` would be read as a workflow command in a CI log; nothing printed may begin so.
  const printable = (s: string): string => mask(s).replace(/^(\s*)(::|##\[)/gm, "$1- $2");
  const err = (s: string): void => io.err(printable(s));
  const out = (s: string): void => io.out(printable(s));

  const outDir = opts.out ? resolve(opts.out) : join(defaultRunsBaseDir(), `mcp-${randomUUID()}`);
  const timeoutMs = Math.round(timeoutSeconds * 1000);
  let conn: McpConnection | undefined;
  let pid: number | null = null;
  /** Writes files as given: whatever must be masked is masked before it gets here. */
  const writeFiles = async (files: Array<[string, string]>): Promise<void> => {
    await mkdir(outDir, { recursive: true });
    for (const [name, text] of files) await writeFile(join(outDir, name), text, "utf8");
  };

  try {
    try {
      conn = await connectMcp({
        ...(command ? { command } : { url: url as string }),
        headers,
        env,
        ...(opts.cwd ? { cwd: resolve(opts.cwd) } : {}),
        timeoutMs,
        secrets,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.importer ? { importer: opts.importer } : {}),
      });
    } catch (e) {
      if (!(e instanceof McpTestError)) throw e;
      pid = e.pid;
      err(`✗ ${e.message}\n`);
      if (e.stderr) {
        err("  The server's stderr (last lines):\n");
        for (const line of stderrTail(e.stderr)) err(`${line}\n`);
        await writeFiles([[STDERR_FILE, mask(e.stderr)]]);
      }
      return { exitCode: 1, pid };
    }
    pid = conn.pid;
    const found = await discoverModel(conn.source, { maxPages, maxEntries, ...(opts.signal ? { signal: opts.signal } : {}) }, {
      transport: conn.transport,
      headerNames: Object.keys(headers),
      envNames: Object.keys(env),
    });
    // Lists are put in order by their own names, THEN string values are masked (so the order does not depend on --env),
    // then the summary is rendered: safeText cuts long values, and a cut must not leave the start of a secret.
    const model = maskStrings(canonicalModel(found), secrets);
    const modelText = serializeCanonical(model);
    try {
      JSON.parse(modelText);
    } catch {
      err("✗ The model could not be written as valid JSON; nothing was saved.\n");
      return { exitCode: 1, pid };
    }
    const stderrLog = mask(conn.stderrText());
    await writeFiles([
      [MODEL_FILE, modelText],
      ...(stderrLog ? ([[STDERR_FILE, stderrLog]] as Array<[string, string]>) : []),
    ]);
    for (const line of renderModelSummary(model)) out(`${line}\n`);
    out(`  Model: ${join(outDir, MODEL_FILE).replace(/\\/g, "/")}\n`);
    if (opts.signal?.aborted) {
      err("✗ Interrupted while reading the lists; the model written is incomplete.\n");
      return { exitCode: 1, outDir, model, pid };
    }
    if (model.tools.length === 0) {
      err(`✗ Nothing to test: the server has no tools (${basename(outDir)}). This is not a pass.\n`);
      return { exitCode: NOTHING_TO_TEST_EXIT_CODE, outDir, model, pid };
    }
    // The call guard works on the tools as the server listed them (not the masked copy) and on the names as typed.
    const tools = canonicalModel(found).tools;
    const missing = unknownToolNames(allowTools, tools);
    if (missing.length) {
      err(`✗ --allow-tools names tools the server does not have: ${missing.map((n) => `"${safeText(n, 60)}"`).join(", ")}. Names are compared exactly (case and spaces included).\n`);
      return { exitCode: 1, outDir, model, pid };
    }
    const guard = new McpCallGuard({
      tools,
      allowTools,
      allowReadOnlyHints: opts.allowReadOnlyHints === true,
      allowMutations: opts.allowMutations === true,
      maxCalls,
      rps: callRps,
      ...(timeBudgetSeconds !== undefined ? { timeBudgetMs: Math.round(timeBudgetSeconds * 1000) } : {}),
    });
    for (const line of renderProposal(assessTools(tools))) out(`${line}\n`);
    // The report and the hint/name disagreements are written on every read, whether or not calls are asked for.
    const report = maskStrings(guard.report(), secrets);
    await writeFiles([[GUARD_FILE, `${JSON.stringify(sortKeys(report), null, 2)}\n`]]);
    // Cases are built from the schemas as listed; nothing here sends a call.
    // Nothing after this needs this connection, and checking schemas can take a while: let it go first. A run that
    // sends calls opens a new one afterwards (the guard compares the tool list again before the first call of a tool).
    pid = conn.pid ?? pid;
    await conn.close();
    conn = undefined;
    err(`checking ${tools.length} tool schemas…\n`);
    if (adv.empty) err("⚠ --adversarial named no style, so no adversarial cases were made (style names are lower-case: normal, curious, psycho, hacker).\n");
    if (adv.unknown.length) {
      err(`⚠ --adversarial: unknown style ${adv.unknown.map((n) => `"${safeText(n, 40)}"`).join(", ")} is ignored (styles: ${MCP_ADVERSARIAL_STYLES.join(", ")}).\n`);
    }
    // A case whose argument holds a masked value is moved to `skipped`: the masked copy would no longer match the schema.
    const generated = generateMcpCases(tools, {
      maxCasesPerTool,
      ...(examples ? { examples } : {}),
      ...(adv.styles.length
        ? {
            adversarial: {
              styles: adv.styles,
              maxStringLength: advLimits.maxStringLength,
              maxDepth: advLimits.maxDepth,
              http: { authenticated: url !== undefined && Object.keys(headers).length > 0 },
              allowTools,
              expectAuth: opts.expectAuth === true,
            },
          }
        : {}),
    });
    // What the guard would say about each adversarial case now (policy only; nothing is recorded or sent).
    for (const c of generated.adversarial ?? []) {
      const d = guard.decide({ tool: c.tool, style: c.style });
      c.guard = { allowed: d.allowed, reason: d.reason };
    }
    const dropped = dropMaskedCases(generated, secrets);
    const cases = maskStrings(dropped, secrets);
    await writeFiles([[CASES_FILE, `${JSON.stringify(sortKeys(cases), null, 2)}\n`]]);
    // Both kinds of --examples error come after the file is written.
    const toolNames = new Set(tools.map((t) => t.name));
    const unknownExamples = Object.keys(examples ?? {}).filter((n) => !toolNames.has(n));
    if (unknownExamples.length) {
      err(`✗ --examples names tools the server does not have: ${unknownExamples.map((n) => `"${safeText(n, 60)}"`).join(", ")}.\n`);
    }
    for (const e of cases.errors) err(`✗ ${e.message}\n`);
    if (unknownExamples.length || cases.errors.length) return { exitCode: 1, outDir, model, pid };
    // Without a flag that sends calls this command only writes the cases.
    if (cases.adversarial && !callsRequested) {
      out(`  Adversarial: none was sent (no flag asked for calls). ${cases.adversarial.length} cases are of the mutating styles (psycho, hacker): ${opts.allowMutations === true ? "they need the tool named in --allow-tools" : "not sent: mutations disabled"}.\n`);
    }
    if (!callsRequested) {
      for (const line of renderMismatches(report.mismatches)) out(`${line}\n`);
      for (const line of renderCasesSummary(cases)) out(`${line}\n`);
      out(`  Cases: ${join(outDir, CASES_FILE).replace(/\\/g, "/")}\n`);
      return { exitCode: 0, outDir, model, pid };
    }
    // --- Sending: only through the guard, one call per case. ---
    const runnable: RunnableCase[] = [
      ...dropped.cases.map((c): RunnableCase => ({ ...c, type: c.type, expect: c.expect as RunnableCase["expect"] })),
      ...(dropped.adversarial ?? []).map((c): RunnableCase => ({ ...c, expect: { outcome: "robust", failedWhen: c.expect.failedWhen } })),
    ];
    const open = async (hdrs: Record<string, string>): Promise<McpConnection> =>
      connectMcp({
        ...(command ? { command } : { url: url as string }),
        headers: hdrs,
        env,
        ...(opts.cwd ? { cwd: resolve(opts.cwd) } : {}),
        timeoutMs,
        secrets,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.importer ? { importer: opts.importer } : {}),
      });
    const limits = { maxPages, maxEntries };
    const linkOf = (c: McpConnection): Link => ({
      request: (r, o) => c.request(r, o),
      transport: c.transport,
      relist: () => discoverTools(c.source, limits),
    });
    err(`▸ Running ${runnable.length} case(s) through the call guard…\n`);
    try {
      conn = await open(headers);
    } catch (e) {
      if (!(e instanceof McpTestError)) throw e;
      pid = e.pid;
      err(`✗ ${e.message}\n`);
      return { exitCode: 1, outDir, model, pid };
    }
    pid = conn.pid ?? pid;
    const restart = async (): Promise<Link | undefined> => {
      try {
        await conn?.close();
        conn = await open(headers);
        pid = conn.pid ?? pid;
        return linkOf(conn);
      } catch {
        conn = undefined;
        return undefined;
      }
    };
    const run = await runCases(runnable, {
      guard,
      tools,
      link: linkOf(conn),
      restart,
      callTimeoutMs: callTimeoutMs,
      ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: parseDecimal("--max-response-bytes", opts.maxResponseBytes) } : {}),
      secrets,
      logDir: outDir,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const results: CaseResult[] = [...run.results];
    const findings: Finding[] = [];
    const lost: string[] = [];
    // The call without credentials: HTTP with credentials only, once, described by the case generator.
    const anon = dropped.noCredentials;
    if (anon && url !== undefined && !opts.signal?.aborted) {
      const probe = await runAnonymousProbe({
        record: { tool: anon.tool, args: anon.args, expectAuth: anon.expectAuth },
        guard,
        connect: async () => {
          try {
            const c = await open({});
            return { link: linkOf(c), close: () => c.close() };
          } catch (e) {
            return e instanceof McpTestError && e.kind === "auth-required" ? "auth-required" : undefined;
          }
        },
        callTimeoutMs: callTimeoutMs,
        secrets,
        logDir: outDir,
      });
      results.push(probe.result);
      if (probe.finding) findings.push({ kind: "anonymous-call-succeeded", tool: anon.tool });
      runnable.push({ name: probe.result.name, stableId: probe.result.stableId, tool: anon.tool, kind: "no-credentials", type: "Negative", args: anon.args, expect: { outcome: "rejected" } });
    }
    // Everything below is an optional part: one that fails is named in the report and the results stay.
    const guardReport = maskStrings(guard.report(), secrets);
    // The file written before the run said nothing was sent; now it says what was.
    await writeFiles([[GUARD_FILE, `${JSON.stringify(sortKeys(guardReport), null, 2)}\n`]]);
    const coverCases = [...dropped.cases, ...runnable.filter((c) => !dropped.cases.some((d) => d.name === c.name))];
    const coverage = settle("coverage", lost, () => computeMcpCoverage(tools, coverCases, results));
    const gate = coverage && minCoverage !== undefined ? evaluateMcpGate(coverage, minCoverage, opts.countPartial === true) : undefined;
    const reportInput = {
      runId: basename(outDir),
      url: maskSecrets(url ?? (command?.[0] ?? ""), secrets),
      results,
      cases: runnable,
      toolCount: tools.length,
      guard: guardReport,
      ...(coverage ? { coverage } : {}),
      ...(gate ? { gate } : {}),
      findings,
      ...(run.stopped ? { stopped: run.stopped } : {}),
      lost,
    };
    const put = (name: string, text: string | undefined): Promise<void> => (text === undefined ? Promise.resolve() : writeFiles([[name, maskSecrets(text, secrets)]]));
    await put(EVIDENCE_FILE, settle("evidence", lost, () => `${JSON.stringify(buildEvidence(results), null, 2)}\n`));
    await put(REPORT_FILE, settle("report.json", lost, () => `${JSON.stringify(buildReportJson(reportInput), null, 2)}\n`));
    await put("report.md", settle("report.md", lost, () => renderMcpReportMd(reportInput)));
    const docs = settle("case documents", lost, () => buildMcpTestCaseDocs(runnable, results, "MCP"));
    for (const d of docs ?? []) {
      await mkdir(join(outDir, "testcases"), { recursive: true });
      await writeFile(join(outDir, "testcases", `${d.id}.md`), maskSecrets(d.md, secrets), "utf8");
    }
    const counts = countStates(results);
    out(`=== Run: ${counts.passed} passed, ${counts.failed} failed, ${counts["needs-review"]} need review, ${counts["could-not-run"]} could not run, ${counts["not-sent"]} not sent ===\n`);
    if (counts["needs-review"]) out(`  ${counts["needs-review"]} case(s) were answered but not judged: a person has to look.\n`);
    if (run.stopped) err(`✗ The run was stopped early: ${safeText(run.stopped, 200)}. The rest was not measured.\n`);
    for (const f of findings) out(`  Finding: ${f.kind} (${safeText(f.tool, 60)})\n`);
    for (const l of lost) err(`⚠ Not built: ${l}\n`);
    if (coverage) for (const line of renderMcpCoverage(coverage, gate)) out(`${line}\n`);
    for (const line of renderGuardReport(guard.report())) out(`${line}\n`);
    const code = mcpExitCode({ results, ...(run.stopped ? { stopped: run.stopped } : {}), ...(gate ? { gate } : {}), budgetExhausted: guard.report().budgetExhausted });
    if (code === NOTHING_PROVEN_EXIT_CODE) err("✗ Nothing was proven: no case passed (none was sent, or every answer needed a person or never came). This is not a pass.\n");
    return { exitCode: code, outDir, model, pid };
  } finally {
    // The server never outlives the run, on success, error, timeout or interrupt.
    if (conn) {
      pid = conn.pid ?? pid;
      await conn.close();
    }
  }
}
