import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** #24: `cairn collect-docs` and its alias `cairn docs` reach the runner with the flags; the summary is printed. */
const { runCollectDocs } = vi.hoisted(() => ({ runCollectDocs: vi.fn() }));
vi.mock("../../src/agent/collect-docs.js", () => ({ runCollectDocs, DEFAULT_MAX_SCREENS: 10 }));

import { buildProgram } from "../../src/cli/index.js";

let out: string[];
let spies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  out = [];
  spies = [
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out.push(String(c));
      return true;
    }),
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  ];
  runCollectDocs.mockReset();
  runCollectDocs.mockResolvedValue({
    outDir: "/runs/docs-1",
    docsFile: "/runs/docs-1/docs.md",
    openApiFile: "/runs/docs-1/openapi.derived.json",
    model: {
      origin: "http://a.test",
      sections: [
        { kind: "Screen", title: "Home" },
        { kind: "Dialog", title: "New project" },
      ],
      questions: ['Screen "Home": What does "SLA" mean?'],
    },
    described: 1,
    cached: 0,
    cost: { perRole: [], totalTokens: 0, totalCostUsd: 0 },
  });
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  vi.stubEnv("LLM_PROFILE", "anthropic");
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
  vi.unstubAllEnvs();
});

describe("cairn collect-docs (CLI)", () => {
  for (const name of ["collect-docs", "docs"]) {
    it(`cairn ${name} passes the flags to the runner and prints where the docs are`, async () => {
      await buildProgram().parseAsync(["node", "cairn", name, "--url", "http://a.test", "--session", "s1", "--max-pages", "4", "--out", "d", "--fresh"]);
      expect(runCollectDocs).toHaveBeenCalledTimes(1);
      expect(runCollectDocs.mock.calls[0]![0]).toMatchObject({ url: "http://a.test", sessionName: "s1", maxScreens: 4, out: "d", fresh: true });
      const text = out.join("");
      expect(text).toContain("=== Docs: 1 screen(s), 1 overlay(s), 1 question(s) → /runs/docs-1/docs.md ===");
      expect(text).toContain("  Dialog: New project");
      expect(text).toContain("Descriptions: 1 written by the model, 0 reused from the cache");
      expect(text).toContain("OpenAPI draft from the traffic: /runs/docs-1/openapi.derived.json");
    });
  }

  it("needs --url", async () => {
    const program = buildProgram();
    program.exitOverride();
    for (const c of program.commands) c.exitOverride();
    await expect(program.parseAsync(["node", "cairn", "collect-docs"])).rejects.toThrow(/--url/);
    expect(runCollectDocs).not.toHaveBeenCalled();
  });

  it("refuses a --max-pages that is no whole number", async () => {
    await expect(buildProgram().parseAsync(["node", "cairn", "docs", "--url", "http://a.test", "--max-pages", "0"])).rejects.toThrow(/--max-pages must be a whole number/);
    expect(runCollectDocs).not.toHaveBeenCalled();
  });
});
