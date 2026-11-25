/**
 * `cairn propose-failures`: variants of one eval of `plune.yaml` under a provider failure, for a person to review.
 * No model is called and no answer is written here. The answer the provider gives after the failure is the one the
 * person recorded with `plune mock --record`; a variant is that recorded stub with a `failure` added, and the eval as
 * written with a new id and that stub file. Nothing is run and nothing is written into `plune.yaml`.
 *
 * What a variant checks: the stub server answers the model call of the `plune run` client itself, so a variant says
 * how the eval (its prompt, its checks, the client's retries) survives the failure, not how the user's product does.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { stableCaseId } from "../artifacts/contract.js";
import { defaultRunsBaseDir } from "../fs/run-dir.js";
import { safeText } from "../mcp-test/model.js";

export const PROPOSED_FILE = "plune.failures.proposed.yaml";
export const SUMMARY_FILE = "failure-variants.json";
/** A `design`-kind run artifact (cases under `testCases`, no verdict): `plune ingest <run>/variants` puts every variant in the review queue. */
export const VARIANTS_DIR = "variants";
export const STUBS_DIR = "stubs";
/** The failure kinds of a stub file (version 1), in the order they are proposed. */
export const FAILURE_KINDS = ["http_500", "http_429", "reset", "timeout", "slow_stream", "truncated_json"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];
/** `plune run` reads a stub file of at most 1 MiB, so a larger recording gives no variant it could run. */
const MAX_FILE_BYTES = 1024 * 1024;
/** The longest eval id whose variants fit the review queue: its title takes 300 characters, its explanation 400. */
export const MAX_EVAL_ID = 64;
/** The retries of the `plune run` client when the config names none. */
const DEFAULT_MAX_RETRIES = 2;
/** Slow enough to notice, fast enough to end: a 1 KiB answer takes four seconds. A person changes it in the stub file. */
const SLOW_BYTES_PER_SEC = 256;
/** One stub of a recording, kept as it was read: only the fields that pick an answer are looked at. */
export type RecordedStub = Record<string, unknown>;

export interface Provider {
  model?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface SourceEval {
  id: string;
  /** The eval's lines as written, re-indented to sit under `evals:` (the item at two spaces). */
  block: string[];
  provider: Provider;
}

export interface Variant {
  id: string;
  failure: Record<string, unknown> & { type: FailureKind };
  /** The stub file of the variant: the eval's recorded answers, each with the failure. */
  stubs: RecordedStub[];
  title: string;
  expected: string;
  rationale: string;
}

export interface Rejected {
  id: string;
  reason: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const indentOf = (line: string): number => line.length - line.trimStart().length;
/** A line that ends no block: blank, or a comment. */
const idle = (line: string): boolean => /^\s*(#.*)?$/.test(line);

/** `key:` at exactly `indent` and everything nested under it, as one text; empty when the key is not there. */
function nested(lines: readonly string[], key: string, indent: number): string {
  const at = lines.findIndex((l) => indentOf(l) === indent && l.trimStart().startsWith(`${key}:`));
  if (at < 0) return "";
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => !idle(l) && indentOf(l) <= indent);
  return [lines[at], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

/** A line without its comment: a `#` at the start of the line or after a space, outside quotes. */
function uncomment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] as string;
    if (quote !== "") quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) return line.slice(0, i);
  }
  return line;
}

/**
 * The `provider` key at exactly `indent` with what is nested under it, comments taken out; empty when it is not there.
 * Refused, not guessed: a list of providers (`plune run` then runs every eval once per model, and a recording answers
 * one of them) and a YAML alias, whose values are written somewhere else.
 */
function providerText(lines: readonly string[], indent: number, where: string): string {
  const at = lines.findIndex((l) => indentOf(l) === indent && l.trimStart().startsWith("provider:"));
  if (at < 0) return "";
  // An anchor on the key line names the value and is no part of it.
  const inline = uncomment((lines[at] as string).trimStart().slice("provider:".length)).trim().replace(/^&\S+\s*/, "");
  const first = lines.slice(at + 1).map(uncomment).find((l) => l.trim() !== "");
  // A list may sit at the indent of its key, so its dash, or the bracket of a flow list, is looked for from there on.
  if (inline.startsWith("[") || (inline === "" && first !== undefined && indentOf(first) >= indent && /^(\[|-(\s|$))/.test(first.trimStart()))) {
    throw new Error(`${where} is a list of models: plune run runs every eval once for every model of the list, and a recording answers one of them. Make the variants from a plune.yaml with one provider.`);
  }
  const text = nested(lines, "provider", indent).split("\n").map(uncomment).join("\n");
  if (inline.startsWith("*") || /<<[ \t]*:/.test(text)) throw new Error(`${where} is given as a YAML alias, which is not read here: write its model, timeout and max_retries out.`);
  return text;
}

function providerIn(text: string): Provider {
  const word = (key: string): string | undefined => {
    const m = new RegExp(`\\b${key}:[ \\t]*(?:"([^"]*)"|'([^']*)'|([^\\s"',}\\]]+))`).exec(text);
    return m?.[1] ?? m?.[2] ?? m?.[3];
  };
  const num = (key: string): number | undefined => (/^\d+$/.test(word(key) ?? "") ? Number(word(key)) : undefined);
  const p: Provider = {};
  const model = word("model");
  const timeout = num("timeout");
  const maxRetries = num("max_retries");
  if (model !== undefined) p.model = model;
  if (timeout !== undefined) p.timeout = timeout;
  if (maxRetries !== undefined) p.maxRetries = maxRetries;
  return p;
}

/**
 * The eval `id` of a `plune.yaml`, read line by line: its lines as written and the provider it runs on (the root
 * `provider`, overridden by the eval's own).
 * Limit: not a YAML parse (Cairn has no YAML dependency). `evals` has to be a block list (`- id: x` items, one key per
 * line), and the provider one object with `model`, `timeout` and `max_retries` as plain or quoted values; an eval
 * written another way is reported as not found, and a provider that is a list or an alias is refused.
 */
export function readEval(planText: string, id: string): SourceEval {
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`--eval must be an eval id of plune.yaml: lowercase letters, digits, "-" and "_" (got "${safeText(id, 60)}").`);
  if (id.length > MAX_EVAL_ID) throw new Error(`--eval: the id is longer than ${MAX_EVAL_ID} characters, and the texts of its variants would not fit the review queue (a title of 300 characters, an explanation of 400). Give the eval a shorter id.`);
  const lines = planText.split(/\r?\n/);
  const top = lines.findIndex((l) => /^evals:[ \t]*(#.*)?$/.test(l));
  const body = top < 0 ? [] : lines.slice(top + 1);
  const end = body.findIndex((l) => !idle(l) && indentOf(l) === 0 && !l.startsWith("- "));
  const evals = end < 0 ? body : body.slice(0, end);
  const firstItem = evals.find((l) => /^\s*- /.test(l));
  const listIndent = firstItem === undefined ? 0 : indentOf(firstItem);
  const isItem = (l: string): boolean => indentOf(l) === listIndent && l.trimStart().startsWith("- ");
  const idLine = new RegExp(`^\\s*(?:- )?id:[ \\t]*(["']?)${id}\\1[ \\t]*(#.*)?$`);
  for (let i = 0; i < evals.length; i += 1) {
    if (!isItem(evals[i] as string)) continue;
    const next = evals.findIndex((l, j) => j > i && isItem(l));
    const item = evals.slice(i, next < 0 ? evals.length : next);
    // Blank lines and the comments above the next item are not the eval's. A `#` line indented deeper than the item is
    // kept: it may be the last line of a block scalar, which is text of the prompt and not a comment.
    const trailing = (l: string): boolean => l.trim() === "" || (idle(l) && indentOf(l) <= listIndent);
    while (item.length > 0 && trailing(item.at(-1) as string)) item.pop();
    // The keys of the item sit two columns in from its dash; a deeper `id:` belongs to something nested.
    const keyIndent = listIndent + 2;
    if (!item.some((l, j) => idLine.test(l) && (j === 0 || indentOf(l) === keyIndent))) continue;
    // The dash line holds the first key: read it as that key at the key indent.
    const keys = [`${" ".repeat(keyIndent)}${(item[0] as string).trimStart().slice(2)}`, ...item.slice(1)];
    if (nested(keys, "mcp", keyIndent) !== "") throw new Error(`eval "${id}" has mcp: a stub file answers the model call of an eval without mcp, so it gets no failure variant.`);
    return {
      id,
      block: item.map((l) => (idle(l) && indentOf(l) < listIndent ? l.trimStart() : `  ${l.slice(listIndent)}`)),
      provider: { ...providerIn(providerText(lines, 0, "the root provider of plune.yaml")), ...providerIn(providerText(keys, keyIndent, `the provider of eval "${id}"`)) },
    };
  }
  throw new Error(`no eval "${id}" under evals: in the plune.yaml (it is read line by line: a block list of "- id: ${id}" items).`);
}

/**
 * The stubs of a recording as `plune mock --record` writes it: comment lines, then one JSON document.
 * Limit: not a YAML parse (Cairn has no YAML dependency), so a stub file rewritten by hand as YAML is refused.
 * The error never holds text of the file: a recording holds prompts and answers.
 */
export function readRecording(text: string): RecordedStub[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^(?:[ \t]*#.*(?:\r?\n|$))+/, ""));
  } catch {
    throw new Error("the recording is not in the form `plune mock --record` writes (comment lines, then JSON).");
  }
  if (!isObject(doc) || doc["version"] !== 1 || !Array.isArray(doc["stubs"])) throw new Error("the recording is not a stub file: a stub file has version: 1 and a list of stubs.");
  return doc["stubs"].filter(isObject);
}

/** A recorded answer to the eval's model call: a POST whose body names the eval's model, a 2xx response with a body, and no failure of its own. */
function isAnswer(stub: RecordedStub, model: string): boolean {
  const response = stub["response"];
  if (!isObject(response) || stub["failure"] !== undefined) return false;
  const status = response["status"] ?? 200;
  const body = stub["body"];
  return (
    String(stub["method"] ?? "POST").toUpperCase() === "POST" &&
    isObject(body) &&
    body["model"] === model &&
    typeof status === "number" &&
    status >= 200 &&
    status <= 299 &&
    ["json", "sse", "text"].some((k) => response[k] !== undefined)
  );
}

const CALLS = (n: number): string => (n === 1 ? "the first call" : `the first ${n} calls`);

/** What each kind does to the eval's call: the failure as the stub file takes it, and what a reviewer reads. */
type Described = { failure: Variant["failure"]; what: string; expected: string } | { reason: string };
function failureOf(kind: FailureKind, source: SourceEval, stubs: readonly RecordedStub[]): Described {
  const retries = source.provider.maxRetries ?? DEFAULT_MAX_RETRIES;
  const passes = `The run passes as eval "${source.id}" does: the client of plune run tries again and gets the recorded answer.`;
  const retried = (first: number, what: string, extra: Record<string, unknown> = {}): Described =>
    retries === 0 ? { reason: "provider.max_retries is 0: no call is tried again, so the recorded answer would never arrive" } : { failure: { type: kind, first, ...extra }, what: `${CALLS(first)} ${what}`, expected: passes };
  switch (kind) {
    case "http_500":
      return retried(Math.min(DEFAULT_MAX_RETRIES, retries), "to the provider end with HTTP 500");
    case "http_429":
      return retried(1, "to the provider ends with HTTP 429 and retry-after of 1 second", { retry_after_seconds: 1 });
    case "reset":
      return retried(1, "to the provider ends with a connection reset");
    case "timeout":
      if (source.provider.timeout === undefined) return { reason: "provider.timeout is not set: only the client's own timeout ends such a call, and plune run refuses a timeout stub without it" };
      return retried(1, "to the provider is never answered, until the client's own timeout");
    case "slow_stream":
      return {
        failure: { type: kind, bytes_per_sec: SLOW_BYTES_PER_SEC },
        what: `the provider's answer arrives at ${SLOW_BYTES_PER_SEC} bytes per second`,
        expected: `The run passes as eval "${source.id}" does, later: the whole recorded answer arrives, slowly. With provider.timeout set, an answer that takes longer than it errors the row.`,
      };
    case "truncated_json":
      if (stubs.some((s) => (s["response"] as Record<string, unknown>)["json"] === undefined)) return { reason: "the recorded answer is not JSON (a stream or a text), and only a JSON body is cut" };
      return {
        failure: { type: kind },
        what: "half of the provider's answer arrives and the connection ends",
        // No `first`: the stub cuts the answer of every call, so a client that tries again gets the half again.
        expected: "The row is errored and plune run exits 2: every call gets half of the recorded answer, so no attempt gets a whole one. Keep the variant only to pin that the eval reports the failure, not a pass.",
      };
  }
}

/**
 * The variants of `source` from the stubs of a recording; `planText` is the text of `plune.yaml`, whose ids are not
 * proposed again. Throws when the recording holds no answer for the eval.
 */
export function proposeVariants(source: SourceEval, recorded: readonly RecordedStub[], kinds: readonly FailureKind[], planText: string): { accepted: Variant[]; rejected: Rejected[]; repeatsLeftOut: number } {
  const { model } = source.provider;
  if (model === undefined) throw new Error(`cannot read provider.model of eval "${source.id}" (at the root of plune.yaml or on the eval): without it the eval's answers in the recording cannot be told from others.`);
  const answers = recorded.filter((s) => isAnswer(s, model));
  // The same request recorded several times: the last recording answers every repeat (`times: always`), the earlier
  // ones once each. A failure that counts calls needs one stub per request, so the last one is kept.
  const stubs = answers.filter((s) => (s["times"] ?? "always") === "always");
  if (stubs.length === 0) {
    throw new Error(`the recording holds no answer for eval "${source.id}": no POST stub with body.model "${safeText(model, 80)}" and a 2xx response with a body. Record the eval's own call with plune mock --record first.`);
  }
  const accepted: Variant[] = [];
  const rejected: Rejected[] = [];
  for (const kind of kinds) {
    const id = `${source.id}-${kind.replace(/_/g, "-")}`;
    if (new RegExp(`^\\s*(?:- )?id:[ \\t]*["']?${id}["']?[ \\t]*(#.*)?$`, "m").test(planText)) {
      rejected.push({ id, reason: "already in plune.yaml" });
      continue;
    }
    const d = failureOf(kind, source, stubs);
    if ("reason" in d) {
      rejected.push({ id, reason: d.reason });
      continue;
    }
    accepted.push({
      id,
      failure: d.failure,
      stubs: stubs.map((s) => ({ ...s, failure: d.failure })),
      title: `Eval "${source.id}" when ${d.what} (${kind})`,
      expected: d.expected,
      rationale: `Variant of eval "${source.id}": the same prompt, data and checks, but ${d.what}. The answer after the failure is the one recorded from the provider; none was generated. It shows how the eval's own model call survives the failure, not how your product does.`,
    });
  }
  return { accepted, rejected, repeatsLeftOut: answers.length - stubs.length };
}

const stubPath = (v: Variant): string => `${STUBS_DIR}/${v.id}.stubs.yaml`;

/** The variants as `plune.yaml` evals: the eval's own lines, with the variant's id and stub file. */
export function renderProposedYaml(source: SourceEval, variants: readonly Variant[]): string {
  const lines = [
    "# Proposed failure variants of an eval, written by `cairn propose-failures`.",
    "# Nothing here runs by itself. Review each one, move what you agree with into plune.yaml, and copy its stub file",
    `# from ${STUBS_DIR}/ to the same path next to plune.yaml. A run answered from stubs is not a measurement of the model.`,
    "evals:",
  ];
  // After readEval the item sits at two spaces and its keys at four.
  const keyOf = (line: string, i: number): string | undefined => (i === 0 ? /^ {2}- ([\w-]+):/ : /^ {4}([\w-]+):/).exec(line)?.[1];
  const ownStubs = source.block.some((l, i) => keyOf(l, i) === "stubs");
  for (const v of variants) {
    const stubsLine = `stubs: ${JSON.stringify(stubPath(v))}`;
    lines.push(`  # Variant of eval "${source.id}": ${v.title.slice(v.title.indexOf(" when ") + 1)}.`);
    source.block.forEach((line, i) => {
      const key = keyOf(line, i);
      // The eval's own stub file, if it names one, gives way to the variant's.
      if (key === "stubs") lines.push(line.replace(/stubs:.*$/, stubsLine));
      else if (key === "id") lines.push(line.replace(/id:.*$/, `id: ${v.id}`), ...(ownStubs ? [] : [`    ${stubsLine}`]));
      else lines.push(line);
    });
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The stub file of a variant: JSON under comment lines, as a recording is. A YAML reader folds the line break
 * characters JSON leaves as they are inside a string, so those are written as escapes.
 */
export function renderStubFile(v: Variant, source: SourceEval, recordingName: string): string {
  const json = JSON.stringify({ version: 1, stubs: v.stubs }, null, 2).replace(/[\u0085\u2028\u2029\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return [
    `# Written by \`cairn propose-failures\` for eval "${source.id}": the answers recorded in ${safeText(recordingName, 120).replace(/[^\w.-]/g, "_")}, each with the failure ${v.failure.type}.`,
    "# Prompts and answers are stored as they were recorded: they may hold personal or confidential text. Read the file before you commit it.",
    json,
    "",
  ].join("\n");
}

/** A `design`-kind run artifact with one case per variant and no verdict: `plune ingest` turns each into a proposal in the review queue. */
export function buildVariantReport(runId: string, target: string, source: SourceEval, variants: readonly Variant[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    url: target,
    mode: "design",
    testCases: variants.map((v) => ({
      stableId: stableCaseId(["failure-variant", source.id, JSON.stringify(v.failure)]),
      id: v.id,
      title: v.title,
      type: "Negative",
      technique: "provider-failure",
      execution: "auto",
      steps: [
        `Move eval "${v.id}" from ${PROPOSED_FILE} into plune.yaml and copy ${stubPath(v)} to the same path next to plune.yaml.`,
        `Run: plune run --only ${v.id}`,
      ],
      expected: v.expected,
      rationale: v.rationale,
    })),
    // No model was asked.
    cost: { totalTokens: 0, totalCostUsd: 0 },
  };
}

export interface ProposeFailuresOptions {
  /** The id of the eval to make variants of. */
  eval: string;
  /** The stub file recorded with `plune mock --record` while that eval ran. */
  recording: string;
  /** The `plune.yaml` that holds the eval (default `plune.yaml` in the working directory); it is only read. */
  pluneConfig?: string;
  out?: string;
  /** Failure kinds, comma separated (default all six). */
  failures?: string;
}

async function readSmall(file: string, what: string, hint: string): Promise<string> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${what} was not found: ${file.replace(/\\/g, "/")}. ${hint}`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`${what} is over 1 MiB: ${file.replace(/\\/g, "/")}.`);
  return readFile(file, "utf8");
}

export async function runProposeFailures(opts: ProposeFailuresOptions, io: { out: (s: string) => void; err: (s: string) => void }): Promise<{ exitCode: number; outDir: string }> {
  const runId = randomUUID();
  const outDir = opts.out ? resolve(opts.out) : join(defaultRunsBaseDir(), `failures-${runId}`);
  const shown = (p: string): string => p.replace(/\\/g, "/");
  try {
    const names = (opts.failures ?? FAILURE_KINDS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = names.filter((n) => !(FAILURE_KINDS as readonly string[]).includes(n));
    if (unknown.length > 0 || names.length === 0) throw new Error(`--failures: unknown failure ${unknown.map((n) => `"${safeText(n, 40)}"`).join(", ") || "(none given)"}; the kinds are ${FAILURE_KINDS.join(", ")}.`);
    const kinds = FAILURE_KINDS.filter((k) => names.includes(k));
    const planFile = resolve(opts.pluneConfig ?? "plune.yaml");
    const planText = await readSmall(planFile, "plune.yaml", "Name it with --plune-config.");
    const source = readEval(planText, opts.eval);
    const recordingFile = resolve(opts.recording);
    const recorded = readRecording(await readSmall(recordingFile, "the recording", "Record the eval's own call with plune mock --record and name the file with --recording."));
    const { accepted, rejected, repeatsLeftOut } = proposeVariants(source, recorded, kinds, planText);

    if (accepted.length === 0) throw new Error(`no variant can be proposed for eval "${source.id}", so nothing was written:${rejected.map((r) => `\n  ${r.id}: ${r.reason}`).join("")}`);
    // Stub files of an earlier run would stay beside the new ones and be copied next to plune.yaml with them.
    if ((await readdir(outDir).catch(() => [])).length > 0) throw new Error(`--out is not empty: ${shown(outDir)}. Name a new or an empty folder.`);

    await mkdir(join(outDir, STUBS_DIR), { recursive: true });
    await mkdir(join(outDir, VARIANTS_DIR), { recursive: true });
    // The prompts and the recorded answers, for their owner only, as the recorder writes a recording.
    const own = { encoding: "utf8", mode: 0o600 } as const;
    await writeFile(join(outDir, PROPOSED_FILE), renderProposedYaml(source, accepted), own);
    for (const v of accepted) await writeFile(join(outDir, stubPath(v)), renderStubFile(v, source, basename(recordingFile)), own);
    await writeFile(join(outDir, SUMMARY_FILE), `${JSON.stringify({ eval: source.id, accepted: accepted.length, rejected, repeatsLeftOut }, null, 2)}\n`, "utf8");
    await writeFile(join(outDir, VARIANTS_DIR, "report.json"), `${JSON.stringify(buildVariantReport(`${runId}-variants`, basename(planFile), source, accepted), null, 2)}\n`, "utf8");

    io.out(`Failure variants of eval "${source.id}": ${accepted.length} proposed, ${rejected.length} rejected: ${shown(join(outDir, PROPOSED_FILE))}\n`);
    for (const v of accepted) io.out(`  ${v.id}: ${v.failure.type}${typeof v.failure["first"] === "number" ? ` (first ${v.failure["first"]})` : ""}\n`);
    for (const r of rejected) io.out(`  rejected ${r.id}: ${r.reason}\n`);
    if (repeatsLeftOut > 0) io.out(`  Left out: ${repeatsLeftOut} earlier recording(s) of a request recorded more than once; the last one answers.\n`);
    io.out(`  Stub files (they hold the recorded prompts and answers): ${shown(join(outDir, STUBS_DIR))}\n`);
    io.out(`  Review queue: plune ingest ${shown(join(outDir, VARIANTS_DIR))}\n`);
    io.out("  No model was called. Nothing was run and plune.yaml was not changed.\n");
    return { exitCode: 0, outDir };
  } catch (e) {
    io.err(`✗ propose-failures: ${(e as Error).message}\n`);
    return { exitCode: 1, outDir };
  }
}
