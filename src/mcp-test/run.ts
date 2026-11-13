/**
 * MCP-E1 — `cairn mcp-test`: connect to a server, read it, write `mcp-model.json` and a short summary.
 * No case is generated and no tool is called here.
 *
 * Exit codes: 0 read; 1 the server could not be reached or read (did not start, did not answer `initialize`, wants
 * authentication, spoke something else); 5 it was read but offers no tool - nothing to test, which is not "all well".
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parsePositiveInt, parsePositiveNumber, parseBaseUrl, tooShortSecrets } from "../api/guard.js";
import { buildSecrets, maskSecrets, maskStrings } from "./secrets.js";
import { defaultRunsBaseDir } from "../fs/run-dir.js";
import { connectMcp, McpTestError, type McpConnection } from "./connect.js";
import { DEFAULT_MAX_LIST_ENTRIES, DEFAULT_MAX_LIST_PAGES, discoverModel } from "./discover.js";
import { canonicalModel, renderModelSummary, safeText, serializeCanonical, type McpModel } from "./model.js";

export const NOTHING_TO_TEST_EXIT_CODE = 5;
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MODEL_FILE = "mcp-model.json";
export const STDERR_FILE = "server-stderr.log";

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
    return { exitCode: 0, outDir, model, pid };
  } finally {
    // The server never outlives the run, on success, error, timeout or interrupt.
    if (conn) {
      pid = conn.pid ?? pid;
      await conn.close();
    }
  }
}
