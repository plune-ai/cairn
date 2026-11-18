import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Composite action hardening: an expression such as `${{ inputs.x }}` inside a `run:` script is pasted into
// the shell before it runs, so a crafted input becomes a command (script injection). Inputs reach the scripts
// through `env:` and are quoted there instead.
// ponytail: line scan by indentation, not a YAML parser; enough for block and inline `run:` keys.
function runScripts(text: string): { line: number; body: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { line: number; body: string }[] = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(l);
    if (!m) return;
    const indent = m[1].length;
    const parts = [m[2]];
    if (/^[|>]/.test(m[2])) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
        parts.push(next);
      }
    }
    out.push({ line: i + 1, body: parts.join("\n") });
  });
  return out;
}

describe("action/action.yml", () => {
  const text = readFileSync(new URL("../../action/action.yml", import.meta.url), "utf8");

  it("has run scripts to check", () => {
    expect(runScripts(text).length).toBeGreaterThan(0);
  });

  it("no run script interpolates an expression (inputs go through env)", () => {
    const offenders = runScripts(text)
      .filter((s) => s.body.includes("${{"))
      .map((s) => `line ${s.line}`);
    expect(offenders).toEqual([]);
  });
});
