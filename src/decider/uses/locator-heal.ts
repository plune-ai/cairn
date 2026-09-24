/**
 * locator-heal (spec §6.6, ADR-0022), v1: after a test fails on a locator, propose a verified replacement in the
 * repair hint. The generated spec stays plain `@playwright/test` — healing happens after the failure, never inside
 * the code. This part is pure: read the broken locator out of Playwright's error, and narrow the page's elements to
 * the ones a healer may offer — the same or a compatible role, never a destructive one.
 */
import type { ElementRef } from "../../browser/types.js";
import { DESTRUCTIVE } from "../../flow/crawl.js";
import { parseAriaSnapshot } from "../../observe/parse-aria.js";
import { isDeletionIntent } from "../../safety/guardrails.js";

export interface BrokenLocator {
  role: string;
  name?: string;
  /** The `getByRole(…)` text as the error printed it — what the repair hint tells the LLM to replace. */
  source: string;
}

/** `getByRole('role')` or `getByRole('role', { name: 'Name'[, exact: true] })`, with ' or " quotes. */
const GET_BY_ROLE =
  /getByRole\((['"])([a-z]+)\1(?:,\s*\{\s*name:\s*(['"])((?:\\.|(?!\3)[^\\\n])*)\3(?:,\s*exact:\s*(?:true|false))?\s*\})?\)/;

/**
 * The locator a failing test waited for. Nothing to heal from a CSS locator, a regex name, or a chained scope
 * (`getByRole('dialog').getByRole(…)`): a candidate from the whole page may sit outside the scope, and `verify`
 * counts matches on the whole page. A trailing `.first()`, `.last()` or `.nth(i)` is kept out of `source`.
 */
export function parseBrokenLocator(error: string): BrokenLocator | undefined {
  const text = error.replace(/\u001b\[[0-9;]*m/g, ""); // Playwright colours its output
  const m = GET_BY_ROLE.exec(text);
  if (!m) return undefined;
  const after = text.slice(m.index + m[0].length);
  if (text[m.index - 1] === "." || /^\.(?!first\(\)|last\(\)|nth\()/.test(after)) return undefined;
  const name = m[4]?.replace(/\\(.)/g, "$1");
  return { role: m[2]!, ...(name !== undefined ? { name } : {}), source: m[0] };
}

/** Roles one element can be swapped for without changing what the step does. */
const ROLE_FAMILIES: readonly (readonly string[])[] = [
  ["textbox", "searchbox", "combobox"],
  ["checkbox", "switch"],
  ["menuitem", "menuitemcheckbox", "menuitemradio"],
];

export function compatibleRoles(role: string): ReadonlySet<string> {
  return new Set(ROLE_FAMILIES.find((f) => f.includes(role)) ?? [role]);
}

/**
 * The elements a healer may offer for a broken locator: interactive, named, of a compatible role, one per role and
 * name. Never one the crawler would refuse to click (`DESTRUCTIVE`) or that reads as deleting data — safety rules
 * are not optional (spec §3.5), so the decider is never even asked about them.
 */
export function healCandidates(aria: string, broken: BrokenLocator): ElementRef[] {
  const roles = compatibleRoles(broken.role);
  const seen = new Set<string>();
  return parseAriaSnapshot(aria).filter((e) => {
    const name = e.name?.trim();
    if (!e.interactive || !name || !roles.has(e.role)) return false;
    if (DESTRUCTIVE.test(name) || isDeletionIntent(name)) return false;
    const key = `${e.role}\n${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const quote = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The exact locator the repair hint proposes: `getByRole('button', { name: 'Save', exact: true })`. */
export function locatorText(el: { role: string; name: string }): string {
  return `getByRole(${quote(el.role)}, { name: ${quote(el.name)}, exact: true })`;
}
