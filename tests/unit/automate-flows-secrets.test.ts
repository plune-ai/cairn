import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApiFlows } from "../../src/api/flows.js";
import { loadConfig } from "../../src/config/index.js";

const { validateSuite, automateCases } = vi.hoisted(() => ({ validateSuite: vi.fn(), automateCases: vi.fn() }));

vi.mock("../../src/validate/index.js", async (original) => ({ ...(await original<object>()), validateSuite }));
vi.mock("../../src/codegen/index.js", async (original) => ({ ...(await original<object>()), automateCases }));
vi.mock("../../src/browser/preflight.js", async (original) => ({ ...(await original<object>()), ensureBrowsersInstalled: () => undefined }));

const { runAutomate } = await import("../../src/agent/index.js");

/**
 * #250: `cairn automate --flows --validate` runs the fixture itself and puts the failures into the repair hint, which
 * goes to the model's provider. Only the browser run and the model are replaced here; the loop between them is real.
 */
describe("runAutomate --flows --validate: the values the flow file names (#250)", () => {
  const SECRET = "S3CRET q/7";
  const failing = (error: string) => ({ results: [{ test: "t", status: "failed", error }], greenRatio: 0, flakyCount: 0 });
  const passing = { results: [{ test: "t", status: "passed" }], greenRatio: 1, flakyCount: 0 };
  const flows = (path: string) => parseApiFlows(JSON.stringify({ version: 1, flows: [{ name: "thing", steps: [{ method: "GET", path }] }] }));
  let runDir: string;

  beforeEach(async () => {
    vi.stubEnv("FLOW_SECRET", SECRET);
    automateCases.mockReset().mockResolvedValue({ files: [{ path: "t.spec.ts", content: "// a test" }] });
    validateSuite.mockReset();
    runDir = await mkdtemp(join(tmpdir(), "qa-automate-flows-"));
    await writeFile(join(runDir, "report.json"), JSON.stringify({ runId: "r", url: "http://app.test" }), "utf8");
    await mkdir(join(runDir, "testcases"), { recursive: true });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(runDir, { recursive: true, force: true });
  });

  const run = (path: string) =>
    runAutomate({ runDir, config: loadConfig({ LLM_PROFILE: "openrouter", OPENROUTER_API_KEY: "test-key" }), validate: true, apiFlows: flows(path), onProgress: () => undefined });

  it("the repair hint and the report hold none of them, raw or encoded", async () => {
    const error = `expected ${SECRET} at http://app.test/${encodeURIComponent(SECRET)}?k=${new URLSearchParams({ k: SECRET }).toString().slice(2)}`;
    validateSuite.mockResolvedValueOnce(failing(error)).mockResolvedValueOnce(failing(error));
    const result = await run("/api/{{env.FLOW_SECRET}}");
    const hint = automateCases.mock.calls[1]![3] as string;
    expect(hint).toContain("- t: expected [REDACTED] at http://app.test/[REDACTED]?k=[REDACTED]");
    expect(JSON.stringify([hint, result.validation])).not.toMatch(/S3CRET/);
  });

  it("a value no flow names stays as it was", async () => {
    validateSuite.mockResolvedValueOnce(failing(`expected ${SECRET}`)).mockResolvedValueOnce(passing);
    await run("/api/items");
    expect(automateCases.mock.calls[1]![3]).toBe(`- t: expected ${SECRET}`);
  });

  it("a run with flows keeps no trace beside its video: a trace records every request's headers and cookies", async () => {
    validateSuite.mockResolvedValue(passing);
    await run("/api/items");
    expect(validateSuite.mock.calls[0]![1]).toMatchObject({ secretsInRun: true });
  });
});
