import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** #231: `cairn check-docs` reaches the runner with its flags, needs no LLM key, and exits 0 on a match, 2 on a mismatch. */
const { runCheckDocs } = vi.hoisted(() => ({ runCheckDocs: vi.fn() }));
vi.mock("../../src/agent/check-docs.js", () => ({ runCheckDocs }));

import { buildProgram } from "../../src/cli/index.js";

let out: string[];
let spies: ReturnType<typeof vi.spyOn>[];

const result = (mismatches: number) => ({
  outDir: "/runs/check-docs-1",
  reportFile: "/runs/check-docs-1/check-docs.md",
  mismatches,
  report: {
    origin: "http://a.test",
    docsLink: "../docs/docs.md",
    screens: 3,
    overlays: 2,
    mismatches: mismatches
      ? [{ kind: "differs", section: 'Dialog "New project"', anchor: "dialog-new-project", what: "the name of a textbox field", docs: "Name", ui: "Project name" }]
      : [],
    api: { notInSpec: mismatches > 1 ? ["GET /api/ok"] : [], notSeen: [] },
  },
});

beforeEach(() => {
  out = [];
  spies = [
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    }),
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  ];
  runCheckDocs.mockReset();
  process.exitCode = undefined;
  // No LLM key at all: check-docs calls no model.
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("cairn check-docs (CLI)", () => {
  it("matching docs: says so and exits 0, without any LLM key", async () => {
    runCheckDocs.mockResolvedValue(result(0));
    await buildProgram().parseAsync(["node", "cairn", "check-docs", "--docs", "runs/docs-1", "--url", "http://a.test", "--spec", "api.json", "--session", "s1", "--max-pages", "4"]);
    expect(runCheckDocs.mock.calls[0]![0]).toMatchObject({ docs: "runs/docs-1", url: "http://a.test", spec: "api.json", sessionName: "s1", maxScreens: 4, browser: { backend: "lib" } });
    expect(out.join("")).toContain("✓ The docs match the UI.");
    expect(out.join("")).toContain("Report: /runs/check-docs-1/check-docs.md");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("mismatches: lists them and exits 2", async () => {
    runCheckDocs.mockResolvedValue(result(2));
    await buildProgram().parseAsync(["node", "cairn", "check-docs", "--docs", "d", "--url", "http://a.test"]);
    const text = out.join("");
    expect(text).toContain("✗ 2 mismatch(es) between the docs and the UI:");
    expect(text).toContain('  Dialog "New project": the name of a textbox field ("Name" → "Project name") — name differs');
    expect(text).toContain("  API GET /api/ok — in the traffic, not in the spec");
    expect(process.exitCode).toBe(2);
  });

  it("needs --docs and --url", async () => {
    const program = buildProgram();
    for (const c of program.commands) c.exitOverride();
    await expect(program.parseAsync(["node", "cairn", "check-docs", "--url", "http://a.test"])).rejects.toThrow(/--docs/);
    expect(runCheckDocs).not.toHaveBeenCalled();
  });
});
