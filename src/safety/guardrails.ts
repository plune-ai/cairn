import type { PilotVerdict } from "../eval/pilot.js";

/**
 * Two cheap safety rules borrowed from Explorbot (BORROW-04, #91), to land BEFORE any stateful /
 * destructive automation:
 *  1. Provenance-checked verdicts — a "pass" must be backed by evidence the entity it claims really
 *     exists in the run's session log (kills a class of LLM false-positives).
 *  2. Data-protection — never delete pre-existing data or the resource under the current URL; only
 *     items this run created itself are disposable.
 *
 * Pure, side-effect-free — the host wires them into the Pilot judge and the setup planner.
 */

// ── 1. Provenance ───────────────────────────────────────────────────────────

/**
 * Gate a Pilot verdict on provenance: a "pass" that names a created/edited entity is only trusted when
 * that entity actually appears (by name) in the session log. An unfounded "pass" is downgraded to
 * "needs-work" with the reason recorded. Non-"pass" verdicts and read-only runs (no entity) pass through.
 */
export function checkProvenance(verdict: PilotVerdict, sessionLog: string[]): PilotVerdict {
  if (verdict.verdict !== "pass") return verdict;
  const entity = verdict.entity.trim();
  if (!entity) return verdict; // read-only run / nothing claimed → nothing to prove
  const haystack = sessionLog.join("\n").toLowerCase();
  if (haystack.includes(entity.toLowerCase())) return verdict;
  return {
    ...verdict,
    verdict: "needs-work",
    reason:
      `Provenance check: entity "${entity}" was reported as created/edited but is absent from the ` +
      `session log — rejecting "pass" to avoid a false-positive. ${verdict.reason}`.trim(),
  };
}

// ── 2. Data-protection ──────────────────────────────────────────────────────

export interface DeletionContext {
  /** URL of the page/resource under test — deleting it is always forbidden. */
  currentUrl?: string;
  /** Names/ids this run created itself — the ONLY things that may be deleted. */
  selfCreated?: Iterable<string>;
}

export interface GuardResult {
  allowed: boolean;
  /** Human-readable basis for the decision (always set — surfaced to the planner/report). */
  reason: string;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\/+$/, "");

/**
 * Decide whether deleting `target` is permitted. Forbidden: the resource under the current URL, and any
 * pre-existing datum (anything not in `selfCreated`). Permitted: an item this run created itself.
 */
export function guardDeletion(target: string, ctx: DeletionContext = {}): GuardResult {
  const t = target.trim();
  if (!t) return { allowed: false, reason: "Refusing to delete: empty target." };

  if (ctx.currentUrl && norm(t) === norm(ctx.currentUrl)) {
    return { allowed: false, reason: `Refusing to delete the resource under the current URL (${ctx.currentUrl}).` };
  }

  const selfCreated = new Set([...(ctx.selfCreated ?? [])].map(norm));
  if (selfCreated.has(norm(t))) {
    return { allowed: true, reason: `Allowed: "${t}" was created by this run (disposable).` };
  }
  return {
    allowed: false,
    reason: `Refusing to delete pre-existing data "${t}" — only self-created items may be removed.`,
  };
}

/** Words that signal an intent to delete/clear data — used to gate stateful setup steps. */
const DELETION_INTENT = /\b(delete|remove|clear|empty|purge|reset|wipe|drop|teardown|clean\s?-?up)\b/i;

/** Whether a free-text step/precondition expresses an intent to delete or clear data. */
export function isDeletionIntent(text: string): boolean {
  return DELETION_INTENT.test(text);
}
