/**
 * MCP-E3 — adversarial styles for tool arguments: `normal`, `curious`, `psycho`, `hacker`, the same taxonomy as
 * `cairn api` (docs/adr/0019: port the taxonomy, not the mechanism) and, like it, no model (docs/adr/0015).
 *
 * This module only builds data. Nothing here sends a call. A case says what to send and what would count as the server
 * failing (it dies, closes the connection, hangs, or answers 5xx over HTTP); it does not say that an attack worked or not.
 * A server may refuse a value or accept it without harm, and both are fine.
 *
 * Whether a value passes the tool's own schema is decided by the same bounded checker as every other case (cases.ts); a
 * payload inside a valid string is a Positive by schema, and its expectation is about behaviour, not about rejection.
 * Whether a payload was handled safely cannot be read from an answer by a rule written here, so those cases carry
 * `humanOracle: true`.
 *
 * Test ids (OWASP WSTG 4.2, read from the guide's own pages): SQL injection WSTG-INPV-05, reflected script WSTG-INPV-01,
 * command injection WSTG-INPV-12, directory traversal WSTG-ATHZ-01.
 */
import type { ApiCaseTechnique } from "../api/cases.js";
import {
  COMMAND_SUBSTITUTION,
  LONE_SURROGATE_STRING,
  MAX_SAFE_NUMBER,
  NULL_BYTE_STRING,
  PATH_TRAVERSAL,
  SCRIPT_INJECTION,
  SENTINEL_EXTRA_PROPERTY,
  SENTINEL_PROTO_VALUE,
  SQL_INJECTION,
} from "./payloads.js";
import { put } from "./schema.js";

export type AdversarialStyle = "normal" | "curious" | "psycho" | "hacker";
export const MCP_ADVERSARIAL_STYLES: readonly AdversarialStyle[] = ["normal", "curious", "psycho", "hacker"];

export const DEFAULT_MAX_STRING_LENGTH = 100000;
export const MAX_STRING_LENGTH_CAP = 200000;
export const DEFAULT_MAX_DEPTH = 100;
export const MAX_DEPTH_CAP = 100;
export const DEFAULT_MAX_PER_TOOL = 16;
export const DEFAULT_MAX_PER_RUN = 200;

/** `--adversarial` → the styles asked for (in the order of the taxonomy) and the names that are not styles. */
export function parseAdversarialStyles(flag: boolean | string | undefined): { styles: AdversarialStyle[]; unknown: string[] } {
  if (!flag) return { styles: [], unknown: [] };
  if (flag === true) return { styles: [...MCP_ADVERSARIAL_STYLES], unknown: [] };
  const names = [...new Set(flag.split(",").map((s) => s.trim()).filter(Boolean))];
  const known = (n: string): n is AdversarialStyle => (MCP_ADVERSARIAL_STYLES as readonly string[]).includes(n);
  return { styles: MCP_ADVERSARIAL_STYLES.filter((s) => names.includes(s)), unknown: names.filter((n) => !known(n)) };
}

export interface AdversarialOptions {
  styles: readonly AdversarialStyle[];
  maxStringLength?: number;
  maxDepth?: number;
  maxPerTool?: number;
  maxPerRun?: number;
  /** The server is reached over HTTP with credentials: a call without them is described once. */
  http?: { authenticated: boolean };
  /** The tools that may be called, in the order given: the first one that exists is used for the call without credentials. */
  allowTools?: readonly string[];
  /** A call without credentials that goes through is a failure (otherwise it is a finding). */
  expectAuth?: boolean;
}

export interface AdversarialLimits {
  maxStringLength: number;
  maxDepth: number;
  maxPerTool: number;
  maxPerRun: number;
}

export function resolveLimits(o: AdversarialOptions): AdversarialLimits {
  const pick = (name: string, v: number | undefined, def: number, cap: number): number => {
    const n = v ?? def;
    if (!Number.isInteger(n) || n < 1 || n > cap) throw new Error(`adversarial ${name} must be a whole number from 1 to ${cap} (got ${String(v)}).`);
    return n;
  };
  return {
    maxStringLength: pick("maxStringLength", o.maxStringLength, DEFAULT_MAX_STRING_LENGTH, MAX_STRING_LENGTH_CAP),
    maxDepth: pick("maxDepth", o.maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH_CAP),
    maxPerTool: pick("maxPerTool", o.maxPerTool, DEFAULT_MAX_PER_TOOL, 1000),
    maxPerRun: pick("maxPerRun", o.maxPerRun, DEFAULT_MAX_PER_RUN, 100000),
  };
}

/** The first top-level parameter of each kind (by name order), as {@link buildCandidates} needs it. */
export interface Targets {
  string?: string;
  number?: string;
  array?: string;
  object?: string;
}

export interface AdversarialCandidate {
  style: "psycho" | "hacker";
  kind: string;
  /** The parameter changed, or "(root)". */
  target: string;
  args: Record<string, unknown>;
  technique: ApiCaseTechnique;
  wstgId?: string;
  humanOracle: boolean;
  rationale: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function nested(depth: number): unknown {
  let v: unknown = [];
  for (let i = 1; i < depth; i++) v = [v];
  return v;
}

/** Candidates for `psycho` and `hacker`, in the order they are kept when a tool has more than the cap allows. */
export function buildCandidates(base: Record<string, unknown>, targets: Targets, rootClosed: boolean, styles: readonly AdversarialStyle[], limits: AdversarialLimits): AdversarialCandidate[] {
  const out: AdversarialCandidate[] = [];
  const withValue = (key: string, v: unknown): Record<string, unknown> => {
    const a = clone(base);
    put(a, key, v);
    return a;
  };
  const add = (c: Omit<AdversarialCandidate, "humanOracle"> & { humanOracle?: boolean }): void => {
    out.push({ humanOracle: false, ...c });
  };
  if (styles.includes("psycho")) {
    const n = targets.number;
    const s = targets.string;
    if (n !== undefined) {
      add({ style: "psycho", kind: "max-safe-integer", target: n, args: withValue(n, MAX_SAFE_NUMBER), technique: "boundary-value", rationale: "The largest integer a JSON number carries exactly, in a numeric parameter." });
      add({ style: "psycho", kind: "negative-number", target: n, args: withValue(n, -1), technique: "boundary-value", rationale: "A negative number, in a place where a count or an index is often expected." });
    }
    if (s !== undefined) {
      add({ style: "psycho", kind: "long-string", target: s, args: withValue(s, "a".repeat(limits.maxStringLength)), technique: "boundary-value", rationale: `A string of ${limits.maxStringLength} characters.` });
      add({ style: "psycho", kind: "empty-string", target: s, args: withValue(s, ""), technique: "boundary-value", rationale: "An empty string." });
      add({ style: "psycho", kind: "null-byte", target: s, args: withValue(s, NULL_BYTE_STRING), technique: "error-guessing", rationale: "A string with a byte of zero inside." });
      add({ style: "psycho", kind: "lone-surrogate", target: s, args: withValue(s, LONE_SURROGATE_STRING), technique: "error-guessing", rationale: "A string with an unpaired surrogate (not valid Unicode text)." });
    }
    if (targets.array !== undefined) {
      add({ style: "psycho", kind: "deep-array", target: targets.array, args: withValue(targets.array, nested(limits.maxDepth)), technique: "boundary-value", rationale: `An array nested ${limits.maxDepth} levels deep.` });
    }
    if (rootClosed) {
      add({ style: "psycho", kind: "extra-property", target: "(root)", args: withValue(SENTINEL_EXTRA_PROPERTY, SENTINEL_PROTO_VALUE), technique: "error-guessing", rationale: "A property the schema forbids (additionalProperties is false)." });
    }
    const proto = JSON.parse(`{"__proto__":{"sentinel":"${SENTINEL_PROTO_VALUE}"}}`) as Record<string, unknown>;
    if (targets.object !== undefined) {
      add({ style: "psycho", kind: "proto-key", target: targets.object, args: withValue(targets.object, proto), technique: "error-guessing", rationale: "An object with an own key called __proto__." });
    } else {
      add({ style: "psycho", kind: "proto-key", target: "(root)", args: withValue("__proto__", proto["__proto__"]), technique: "error-guessing", rationale: "An own key called __proto__ among the arguments." });
    }
  }
  if (styles.includes("hacker") && targets.string !== undefined) {
    const s = targets.string;
    const inj = (kind: string, value: string, wstgId: string, what: string): void =>
      add({ style: "hacker", kind, target: s, args: withValue(s, value), technique: "error-guessing", wstgId, humanOracle: true, rationale: `${what} (${wstgId}): a harmless string that a careful server refuses or treats as plain text.` });
    inj("sql-injection", SQL_INJECTION, "WSTG-INPV-05", "A piece of SQL");
    inj("script-injection", SCRIPT_INJECTION, "WSTG-INPV-01", "A script tag");
    inj("command-substitution", COMMAND_SUBSTITUTION, "WSTG-INPV-12", "A shell command substitution that names no real command");
    inj("path-traversal", PATH_TRAVERSAL, "WSTG-ATHZ-01", "A path that goes up to a name that does not exist");
  }
  return out;
}

/** What counts as the server failing, and what is fine: the same for every adversarial case. */
export const ROBUST_EXPECTATION = {
  outcome: "robust",
  accepts: ["json-rpc-error", "result-isError", "accepted-without-harm"],
  failedWhen: ["process-exit", "connection-closed", "timeout", "http-5xx"],
} as const;
