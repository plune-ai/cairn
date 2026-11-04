import { describe, it, expect, vi, afterEach } from "vitest";

/** #229: `explore` and `design` take `--api-origin`, and hand it to the run as `apiOrigins`. */
const seen: { apiOrigins?: string }[] = [];
vi.mock("../../src/agent/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/agent/index.js")>()),
  runExploration: async (input: { apiOrigins?: string }) => {
    seen.push(input);
    throw new Error("stop here");
  },
  runDesign: async (input: { apiOrigins?: string }) => {
    seen.push(input);
    throw new Error("stop here");
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  seen.length = 0;
  process.exitCode = 0;
});

describe("--api-origin (#229)", () => {
  it.each(["explore", "design"])("%s has the option and passes it to the run", async (command) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-used");
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { buildProgram } = await import("../../src/cli/index.js");
      const program = buildProgram();
      expect(program.commands.find((c) => c.name() === command)?.options.some((o) => o.long === "--api-origin")).toBe(true);
      await program
        .parseAsync(["node", "cairn", command, "--url", "https://app.example.test/", "--api-origin", "https://api.example.test"])
        .catch(() => undefined);
      expect(seen.at(-1)?.apiOrigins).toBe("https://api.example.test");
    } finally {
      errSpy.mockRestore();
    }
  });
});
