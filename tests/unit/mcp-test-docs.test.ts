import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The guide for `cairn mcp-test` says what the command does: its flags, its states, its exit codes, and its links resolve. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");
const PAGES = ["docs/mcp-test.md", "docs/runbooks/test-an-mcp-server.md", "docs/mcp.md", "docs/README.md"];

/** GitHub's anchor for a heading. */
const slug = (h: string): string => h.toLowerCase().replace(/[`*]/g, "").replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-");
const headings = (md: string): Set<string> => new Set([...md.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1] as string)));

describe("docs · mcp-test · the guide matches the command", () => {
  const cli = read("src/cli/index.ts");
  const block = cli.slice(cli.indexOf('.command("mcp-test")'), cli.indexOf('await runModality("mcp-test"'));
  const flags = [...new Set([...block.matchAll(/\.option\("(--[a-z-]+)/g)].map((m) => m[1] as string))];
  const page = read("docs/mcp-test.md");

  it("every flag of the command is named in the guide (rename one in the code and this goes red)", () => {
    expect(flags.length).toBeGreaterThan(20);
    // The flag, then the end of the name (a space, a backtick, `<` or `[`), so `--allow-tool` is not found inside `--allow-tools`.
    for (const f of flags) expect(page, f).toMatch(new RegExp(String.raw`\`${f}[ \`<\[]`));
  });

  it("every case state and exit code is named", () => {
    for (const s of ["passed", "failed", "not-sent", "could-not-run", "needs-review"]) expect(page, s).toContain(`\`${s}\``);
    for (const c of ["0", "1", "3", "4", "5"]) expect(page, c).toContain(`| \`${c}\` |`);
  });

  it("the safety text comes before the first command that is shown", () => {
    expect(page.indexOf("By default nothing is called")).toBeGreaterThan(-1);
    expect(page.indexOf("By default nothing is called")).toBeLessThan(page.indexOf("```text"));
    expect(page).toMatch(/test account/);
  });

  it("no path of a machine, no tracker number, no release claim", () => {
    for (const rel of PAGES.slice(0, 2)) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/[A-Za-z]:[\/](Users|QA_A)|\/Users\/|scratchpad|AppData/);
      expect(text, rel).not.toMatch(/#\d{3,4}\b/);
      expect(text, rel).not.toMatch(/\bsince version\b|\bv\d+\.\d+\.\d+\b/i);
    }
  });
});

describe("docs · mcp-test · links and fences", () => {
  for (const rel of PAGES) {
    const text = read(rel);
    it(`${rel}: relative links resolve, anchors exist, fences have a language`, () => {
      for (const m of text.matchAll(/\]\((\.{0,2}\/?[^)\s#]*)(#[^)\s]*)?\)/g)) {
        const [, target, anchor] = m;
        if (!target || /^[a-z]+:/.test(target)) continue;
        const file = resolve(root, dirname(rel), target);
        expect(existsSync(file), `${rel} -> ${target}`).toBe(true);
        if (anchor && file.endsWith(".md")) expect(headings(readFileSync(file, "utf8")).has(anchor.slice(1)), `${rel} -> ${target}${anchor}`).toBe(true);
      }
      for (const m of text.matchAll(/\]\((#[^)\s]+)\)/g)) expect(headings(text).has((m[1] as string).slice(1)), `${rel} -> ${m[1]}`).toBe(true);
      if (rel === "docs/README.md") return; // its older fences are not part of this guide
      const fences = text.split("\n").filter((l) => /^\s*```/.test(l));
      // Opening fences come first, closing ones are bare: count the ones that open with a language.
      const opens = fences.filter((_, i) => i % 2 === 0);
      for (const f of opens) expect(f.trim().length, `${rel}: a fence without a language`).toBeGreaterThan(3);
    });
  }
});

describe("docs · mcp-test · what lets a named tool through", () => {
  // The guard lets a tool named in --allow-tools through, without --allow-mutations, on the server's read-only claim
  // alone (nothing contradicting it). The read verb and the ASCII name decide only for --allow-read-only-hints.
  const blocks = (rel: string): string[] => read(rel).split(/\n\s*\n|\n(?=\|)/);
  const ROW_OF_NAMED = /read verb|clean name|plain ASCII|starts with a (?:read )?verb/i;

  it("no part of the guide that speaks of --allow-tools but not of --allow-read-only-hints asks for a read verb or a clean name", () => {
    for (const rel of ["docs/mcp-test.md", "docs/runbooks/test-an-mcp-server.md"])
      for (const b of blocks(rel))
        if (b.includes("`--allow-tools") && !b.includes("--allow-read-only-hints")) expect(b, `${rel}: ${b.slice(0, 80)}`).not.toMatch(ROW_OF_NAMED);
  });

  it("the --allow-tools row of the flag table does not set a condition on the shape of the name", () => {
    const row = read("docs/mcp-test.md").split("\n").find((l) => l.startsWith("| `--allow-tools a,b`")) as string;
    expect(row).toBeDefined();
    expect(row).not.toMatch(ROW_OF_NAMED);
    expect(row).toMatch(/whatever its name is/);
  });

  it("the read verb and the ASCII name are tied to --allow-read-only-hints, and the page shows a named tool with a non-read name going through", () => {
    const page = read("docs/mcp-test.md");
    const row = page.split("\n").find((l) => l.startsWith("| `--allow-read-only-hints`")) as string;
    expect(row).toMatch(/plain ASCII name that starts with a read verb/);
    expect(page).toContain("`send_email` with `readOnlyHint: true`, named in `--allow-tools`, is sent");
    expect(page).toMatch(/refused as `claim not\s+trusted`; naming it in `--allow-tools` lets it through/);
  });

  it("the --allow-mutations row does not describe the read-only rule with a clean name", () => {
    expect(read("docs/mcp-test.md")).not.toMatch(/claimed read-only with a clean name/);
  });
});
