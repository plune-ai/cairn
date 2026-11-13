/**
 * MCP-E4 — the guard that decides, before every tool call, whether it may be sent. (Not `src/api/guard.ts`, which masks
 * secrets and limits HTTP requests for `cairn api`; this one is its own class on its own types.)
 *
 * Nothing is sent by default. A tool is called only when the user named it (`--allow-tools`, exact names) or, with
 * `--allow-read-only-hints`, when the server claims it is read-only and nothing about its name says otherwise. What a
 * server says about itself is not a proof: a `readOnlyHint` alone never allows a call, a tool the server marks
 * destructive is never let through on a hint, and anything that is not proven safe is a mutation, which needs
 * `--allow-mutations` AND the tool's name in `--allow-tools`. `--allow-mutations` alone allows nothing.
 *
 * The decision is taken against the snapshot of the tool list the user saw. If the server later changes a tool (a
 * `list_changed`, a second list), the tool is refused from then on: the permission was given for what was shown.
 *
 * Tool names and titles come from the server and are untrusted text: they are compared byte for byte with the user's
 * names, never by similarity, and printed only through `safeText`.
 */
import { DESTRUCTIVE } from "../flow/crawl.js";
import { isDeletionIntent } from "../safety/guardrails.js";
import { MUTATING_STYLES } from "../api/guard.js";
import { safeText, sortKeys, type McpToolEntry } from "./model.js";

export const DEFAULT_MAX_CALLS = 100;
export const DEFAULT_CALL_RPS = 2;
/** Exit code when the call budget or the time budget is spent (the same as `cairn api`). */
export const CALL_BUDGET_EXIT_CODE = 4;
/** Exit code when no call was sent: nothing was tested. */
export const NOTHING_SENT_EXIT_CODE = 5;

export const MUTATION_BANNER = "Calls may change data: run this on a test account or a stand.";
export const CLAIM_NOTE = "This is the server's claim, not a check.";

/** An error in how the flags were given (not a decision about a call). */
export class GuardUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardUsageError";
  }
}

/** Characters that make an entry of `--allow-tools` look like a pattern: refused, never read as one. */
const PATTERN_CHARS = /[*?[\]{}()|^$\\+]/;

/**
 * `--allow-tools a,b,c` → the names, exactly as written (no trimming, no case folding). An empty list, an empty entry,
 * `all`, or anything that looks like a pattern is a usage error, not a permission.
 */
export function parseAllowTools(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const names = raw.split(",");
  for (const n of names) {
    if (n === "") throw new GuardUsageError('--allow-tools takes tool names separated by commas; an empty name is not accepted (there is no "all").');
    if (n.toLowerCase() === "all" || PATTERN_CHARS.test(n)) {
      throw new GuardUsageError(`--allow-tools takes exact tool names; "${safeText(n, 40)}" is not accepted (no "all", no patterns).`);
    }
  }
  return [...new Set(names)];
}

/** The names of `allowed` that the server does not have, compared exactly. */
export function unknownToolNames(allowed: readonly string[], tools: readonly McpToolEntry[]): string[] {
  const have = new Set(tools.map((t) => t.name));
  return allowed.filter((n) => !have.has(n));
}

/** A tool name or title split into lowercase words: `deleteFile`, `delete_file`, `remove-item` → separate words. */
export function nameWords(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2") // camelCase
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2") // HTTPServer → HTTP Server
    .replace(/[_\-.:/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Whether a name or title reads as a deletion, with the crawler's rules (English, Ukrainian, Russian) after splitting. */
export function readsDestructive(text: string | undefined): boolean {
  if (!text) return false;
  const words = nameWords(text);
  return DESTRUCTIVE.test(words) || isDeletionIntent(words);
}

/** Control, invisible and bidi characters, or a name that is not in normalized form. */
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;
export const hasUnsafeName = (name: string): boolean => UNSAFE_NAME.test(name) || name !== name.normalize("NFC");

export type ToolClass = "read-claimed" | "unknown" | "mutating";

export interface ToolAssessment {
  name: string;
  class: ToolClass;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** The name or title reads as a deletion. */
  destructiveName: boolean;
  /** The name has control or invisible characters. */
  unsafeName: boolean;
  /** Another tool's name is the same, or the same after normalization and case folding. */
  ambiguous: boolean;
  /** Only `read-claimed` tools are proposed. */
  proposed: boolean;
  /** A claim of the server that its own name or hints contradict. */
  mismatch?: string;
}

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const foldName = (n: string): string => n.normalize("NFKC").toLowerCase();

/** Classify every tool of a model. `read-claimed` is the server's word, and only when nothing else contradicts it. */
export function assessTools(tools: readonly McpToolEntry[]): ToolAssessment[] {
  const count = new Map<string, number>();
  for (const t of tools) count.set(foldName(t.name ?? ""), (count.get(foldName(t.name ?? "")) ?? 0) + 1);
  return tools.map((t) => {
    const name = t.name ?? "";
    const a = t.annotations ?? {};
    const readOnlyHint = bool(a["readOnlyHint"]);
    const destructiveHint = bool(a["destructiveHint"]);
    const idempotentHint = bool(a["idempotentHint"]);
    const destructiveName = readsDestructive(name) || readsDestructive(t.title);
    const unsafeName = hasUnsafeName(name);
    const ambiguous = (count.get(foldName(name)) ?? 0) > 1;
    let cls: ToolClass;
    if (destructiveName || readOnlyHint === false || destructiveHint === true) cls = "mutating";
    else if (readOnlyHint === true && !unsafeName && !ambiguous) cls = "read-claimed";
    else cls = "unknown";
    const mismatch =
      readOnlyHint === true && destructiveName
        ? "the server says read-only, the name or title reads as a deletion"
        : readOnlyHint === true && destructiveHint === true
          ? "the server says both read-only and destructive"
          : undefined;
    return {
      name,
      class: cls,
      ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
      ...(destructiveHint !== undefined ? { destructiveHint } : {}),
      ...(idempotentHint !== undefined ? { idempotentHint } : {}),
      destructiveName,
      unsafeName,
      ambiguous,
      proposed: cls === "read-claimed",
      ...(mismatch ? { mismatch } : {}),
    };
  });
}

/** The table of tools and what is proposed for permission. */
export function renderProposal(assessments: readonly ToolAssessment[]): string[] {
  const lines = ["Tools the server offers (nothing is called without your permission):", "  tool | class | proposed for permission"];
  for (const a of assessments) lines.push(`  ${safeText(a.name, 60)} | ${a.class} | ${a.proposed ? "yes" : "no"}`);
  const proposed = assessments.filter((a) => a.proposed);
  if (proposed.length) {
    lines.push(`  Proposed with --allow-read-only-hints or by name in --allow-tools: ${proposed.map((a) => safeText(a.name, 60)).join(", ")}.`);
    lines.push(`  Class read-claimed: ${CLAIM_NOTE}`);
  } else {
    lines.push("  Nothing is proposed: no tool is claimed read-only with a clean name.");
  }
  return lines;
}

export type DenyReason =
  | "not allowed"
  | "mutations not allowed"
  | "destructive name"
  | "not in the model"
  | "ambiguous name"
  | "unsafe name"
  | "changed since permission"
  | "budget exhausted"
  | "time budget exhausted";

export interface McpCallDecision {
  tool: string;
  style?: string;
  allowed: boolean;
  /** Why: what allowed it, or what refused it. */
  reason: DenyReason | "named in --allow-tools" | "named in --allow-tools with --allow-mutations" | "server claims read-only, trusted by --allow-read-only-hints";
  /** What an allowed call rests on: the user's naming, or the server's own claim. */
  basis?: "named" | "server-claim";
}

export interface McpGuardOptions {
  /** The tool list the user saw: the decision is made against this snapshot. */
  tools: readonly McpToolEntry[];
  allowTools?: readonly string[];
  allowReadOnlyHints?: boolean;
  allowMutations?: boolean;
  maxCalls?: number;
  rps?: number;
  /** Milliseconds for the whole run; undefined = no limit. */
  timeBudgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface McpGuardReport {
  policy: { allowTools: string[]; allowReadOnlyHints: boolean; allowMutations: boolean; maxCalls: number; rps: number; timeBudgetMs?: number };
  banner?: string;
  /** An allowed call rests on the server's own claim. */
  restsOnServerClaims: boolean;
  tools: ToolAssessment[];
  proposed: string[];
  mismatches: Array<{ tool: string; detail: string }>;
  changed: string[];
  decisions: McpCallDecision[];
  sent: number;
  denied: number;
  budgetExhausted: boolean;
  notes: string[];
}

const fingerprint = (t: McpToolEntry): string =>
  JSON.stringify(sortKeys({ title: t.title, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema, outputSchema: t.outputSchema }));

export class McpCallGuard {
  private readonly allow: ReadonlySet<string>;
  private readonly allowList: string[];
  private readonly trustHints: boolean;
  private readonly mutations: boolean;
  private readonly maxCalls: number;
  private readonly rps: number;
  private readonly timeBudgetMs: number | undefined;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly startedAt: number;
  private readonly assessments: ToolAssessment[];
  private readonly byName = new Map<string, ToolAssessment>();
  private readonly snapshot = new Map<string, string>();
  private readonly changedSet = new Set<string>();
  private readonly decisions: McpCallDecision[] = [];
  private used = 0;
  private nextSlot = 0;
  private exhausted = false;

  constructor(opts: McpGuardOptions) {
    this.allowList = [...(opts.allowTools ?? [])];
    this.allow = new Set(this.allowList);
    this.trustHints = opts.allowReadOnlyHints ?? false;
    this.mutations = opts.allowMutations ?? false;
    this.maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
    this.rps = opts.rps ?? DEFAULT_CALL_RPS;
    this.timeBudgetMs = opts.timeBudgetMs;
    // Monotonic: a wall-clock step must not open the rate limiter.
    this.now = opts.now ?? (() => performance.now());
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.startedAt = this.now();
    this.assessments = assessTools(opts.tools);
    for (const a of this.assessments) this.byName.set(a.name, a);
    for (const t of opts.tools) this.snapshot.set(t.name ?? "", fingerprint(t));
  }

  /** The server announced a changed list (or it was read again): a tool that is not as it was shown stays refused. */
  observe(tools: readonly McpToolEntry[]): void {
    const seen = new Set<string>();
    for (const t of tools) {
      const name = t.name ?? "";
      seen.add(name);
      const before = this.snapshot.get(name);
      if (before !== undefined && before !== fingerprint(t)) this.changedSet.add(name);
    }
    for (const name of this.snapshot.keys()) if (!seen.has(name)) this.changedSet.add(name);
  }

  /** The decision for one call, by policy alone (budget and rate are applied in {@link admit}). Not recorded. */
  decide(call: { tool: string; style?: string }): McpCallDecision {
    const base = { tool: call.tool, ...(call.style ? { style: call.style } : {}) };
    const deny = (reason: DenyReason): McpCallDecision => ({ ...base, allowed: false, reason });
    const a = this.byName.get(call.tool);
    if (!a) return deny("not in the model");
    if (a.ambiguous) return deny("ambiguous name");
    if (a.unsafeName) return deny("unsafe name");
    if (this.changedSet.has(call.tool)) return deny("changed since permission");
    const named = this.allow.has(call.tool);
    const mutatingStyle = MUTATING_STYLES.has(call.style ?? "");
    const clean = a.class === "read-claimed" && !mutatingStyle;
    if (a.destructiveName && !(named && this.mutations)) return deny("destructive name");
    if (clean) {
      if (named) return { ...base, allowed: true, reason: "named in --allow-tools", basis: "named" };
      if (this.trustHints) return { ...base, allowed: true, reason: "server claims read-only, trusted by --allow-read-only-hints", basis: "server-claim" };
      return deny("not allowed");
    }
    // Not proven safe: a mutation. It needs the name AND --allow-mutations; a hint never lifts it.
    if (!named) return deny(this.mutations ? "not allowed" : "mutations not allowed");
    if (!this.mutations) return deny("mutations not allowed");
    return { ...base, allowed: true, reason: "named in --allow-tools with --allow-mutations", basis: "named" };
  }

  /**
   * The only question a runner asks before sending: the decision, with the budget and the rate applied. An allowed
   * decision has taken one call of the budget (a retry takes another) and waited for its rate slot, which is reserved
   * synchronously, so concurrent callers queue 1/rps apart. Recorded for the report.
   */
  async admit(call: { tool: string; style?: string }): Promise<McpCallDecision> {
    let d = this.decide(call);
    if (d.allowed) {
      if (this.timeBudgetMs !== undefined && this.now() - this.startedAt >= this.timeBudgetMs) {
        this.exhausted = true;
        d = { ...d, allowed: false, reason: "time budget exhausted" };
      } else if (this.used >= this.maxCalls) {
        this.exhausted = true;
        d = { ...d, allowed: false, reason: "budget exhausted" };
      }
    }
    if (d.allowed) {
      this.used += 1;
      const now = this.now();
      const slot = Math.max(now, this.nextSlot);
      this.nextSlot = slot + 1000 / this.rps;
      this.decisions.push(d);
      if (slot > now) await this.sleepFn(slot - now);
    } else {
      this.decisions.push(d);
    }
    return d;
  }

  report(): McpGuardReport {
    const sent = this.decisions.filter((d) => d.allowed).length;
    const notes: string[] = [];
    if (this.mutations && this.allowList.length === 0) notes.push("--allow-mutations without --allow-tools allows nothing.");
    if (this.changedSet.size) notes.push("The server changed some tools after they were shown; calls to them are refused.");
    return {
      policy: {
        allowTools: [...this.allowList],
        allowReadOnlyHints: this.trustHints,
        allowMutations: this.mutations,
        maxCalls: this.maxCalls,
        rps: this.rps,
        ...(this.timeBudgetMs !== undefined ? { timeBudgetMs: this.timeBudgetMs } : {}),
      },
      ...(this.mutations ? { banner: MUTATION_BANNER } : {}),
      restsOnServerClaims: this.decisions.some((d) => d.allowed && d.basis === "server-claim"),
      tools: this.assessments,
      proposed: this.assessments.filter((a) => a.proposed).map((a) => a.name),
      mismatches: this.assessments.filter((a) => a.mismatch).map((a) => ({ tool: a.name, detail: a.mismatch as string })),
      changed: [...this.changedSet],
      decisions: [...this.decisions],
      sent,
      denied: this.decisions.length - sent,
      budgetExhausted: this.exhausted,
      notes,
    };
  }

  /** 4 when a budget ran out, 5 when nothing was sent, 0 otherwise (a failed case is the runner's 1). */
  exitCode(): number {
    if (this.exhausted) return CALL_BUDGET_EXIT_CODE;
    return this.decisions.some((d) => d.allowed) ? 0 : NOTHING_SENT_EXIT_CODE;
  }
}

/** Console lines of the guard's report: the banner first (when mutations are allowed), then what was decided and why. */
export function renderGuardReport(r: McpGuardReport): string[] {
  const lines: string[] = [];
  if (r.banner) lines.push(`⚠ ${r.banner}`);
  lines.push("=== Call guard ===");
  lines.push(
    `  Policy: ${r.policy.allowTools.length} tool(s) named, read-only hints ${r.policy.allowReadOnlyHints ? "TRUSTED" : "not trusted"}, mutations ${r.policy.allowMutations ? "allowed" : "not allowed"}; at most ${r.policy.maxCalls} call(s), ${r.policy.rps}/s.`,
  );
  lines.push(`  Sent: ${r.sent}, refused: ${r.denied}.`);
  if (r.restsOnServerClaims) lines.push(`  Some permission rests on the server's own claim of read-only. ${CLAIM_NOTE}`);
  for (const d of r.decisions.filter((x) => !x.allowed)) lines.push(`  refused ${safeText(d.tool, 60)}: ${d.reason}`);
  for (const d of r.decisions.filter((x) => x.allowed)) lines.push(`  allowed ${safeText(d.tool, 60)}: ${d.reason}`);
  if (r.mismatches.length) {
    lines.push("  Hint and name disagree:");
    for (const m of r.mismatches) lines.push(`    ${safeText(m.tool, 60)}: ${m.detail}`);
  }
  for (const n of r.notes) lines.push(`  Note: ${n}`);
  if (r.budgetExhausted) lines.push("  ✗ The call budget ran out: the rest were not sent and are not counted as passed.");
  return lines;
}
