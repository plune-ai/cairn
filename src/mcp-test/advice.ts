/**
 * MCP-E3 — advice: signs in an error text that a server may be giving away more than it should (a stack, a path of the
 * file system, a piece of SQL). These are heuristics, and an error text may legitimately quote someone else's stack, so
 * they only advise: nothing here is an exit code and nothing here fails a case.
 *
 * The patterns run on text a server sent, so each is bounded and the text is cut first: every quantifier is over a
 * character class that cannot also end the match, and it has an upper bound; the text is read line by line, at most
 * 2000 characters of a line and 200 lines.
 */
import { maskSecrets } from "./secrets.js";
import { safeText } from "./model.js";

export type AdviceKind = "stack" | "path" | "sql";
export interface AdviceFinding {
  kind: AdviceKind;
  /** The line the sign was found in, cut and masked. */
  excerpt: string;
}

const MAX_LINES = 200;
const MAX_LINE = 2000;

const STACK_FRAME = /\bat [^\n\x28\x29]{1,120} \([^\n\x28\x29]{1,300}:\d{1,6}:\d{1,6}\)/;
const PYTHON_TRACE = /Traceback \(most recent call last\)/;
const UNIX_PATH = /(?:^|[\s"'(=])\/(?:home|usr|var|etc|opt|root|srv|app|Users|tmp)\/[^\s"')]{1,200}/;
const WINDOWS_PATH = /(?:^|[\s"'(=])[A-Za-z]:\\[^\s"')]{1,200}/;
const SQL_PIECE = /\b(?:SELECT [^\n]{1,80} FROM|INSERT INTO|UPDATE [A-Za-z_]{1,40} SET|DELETE FROM)\b/i;

export function findAdvice(text: string, secrets: readonly string[]): AdviceFinding[] {
  const out: AdviceFinding[] = [];
  const lines = text.split("\n", MAX_LINES);
  for (const raw of lines) {
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    const kinds: AdviceKind[] = [];
    if (STACK_FRAME.test(line) || PYTHON_TRACE.test(line)) kinds.push("stack");
    if (UNIX_PATH.test(line) || WINDOWS_PATH.test(line)) kinds.push("path");
    if (SQL_PIECE.test(line)) kinds.push("sql");
    for (const kind of kinds) out.push({ kind, excerpt: safeText(maskSecrets(line, secrets), 120) });
  }
  return out;
}
