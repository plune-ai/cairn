/**
 * MCP-E3 — advice: signs in an error text that a server may be giving away more than it should (a stack, a path of the
 * file system, a piece of SQL). These are heuristics, and an error text may legitimately quote someone else's stack, so
 * they only advise: nothing here is an exit code and nothing here fails a case.
 *
 * A finding says which kind of sign and on which line, never what the server wrote: nothing of the text leaves this
 * function. The patterns run on text a server sent, so each is bounded and the text is cut first: every quantifier is
 * over a character class that cannot also end the match, and it has an upper bound; the text is read line by line, at
 * most 2000 characters of a line and 200 lines (the cuts are the protection, and a test pins them).
 */
export type AdviceKind = "stack" | "path" | "sql";
export interface AdviceFinding {
  kind: AdviceKind;
  /** The line the sign was found on, counted from 1. */
  line: number;
}

export const ADVICE_MAX_LINES = 200;
export const ADVICE_MAX_LINE = 2000;

const STACK_FRAME = /\bat [^\n\x28\x29]{1,120} \([^\n\x28\x29]{1,300}:\d{1,6}:\d{1,6}\)/;
const PYTHON_TRACE = /Traceback \(most recent call last\)/;
const UNIX_PATH = /(?:^|[\s"'(=])\/(?:home|usr|var|etc|opt|root|srv|app|Users|tmp)\/[^\s"')]{1,200}/;
const WINDOWS_PATH = /(?:^|[\s"'(=])[A-Za-z]:\\[^\s"')]{1,200}/;
const SQL_PIECE = /\b(?:SELECT [^\n]{1,80} FROM|INSERT INTO|UPDATE [A-Za-z_]{1,40} SET|DELETE FROM)\b/i;

export function findAdvice(text: string): AdviceFinding[] {
  const out: AdviceFinding[] = [];
  const lines = text.split("\n", ADVICE_MAX_LINES);
  lines.forEach((raw, i) => {
    const line = raw.length > ADVICE_MAX_LINE ? raw.slice(0, ADVICE_MAX_LINE) : raw;
    if (STACK_FRAME.test(line) || PYTHON_TRACE.test(line)) out.push({ kind: "stack", line: i + 1 });
    if (UNIX_PATH.test(line) || WINDOWS_PATH.test(line)) out.push({ kind: "path", line: i + 1 });
    if (SQL_PIECE.test(line)) out.push({ kind: "sql", line: i + 1 });
  });
  return out;
}
