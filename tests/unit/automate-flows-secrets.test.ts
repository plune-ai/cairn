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

const SECRET = "S3CRET q/7";
const passing = { results: [{ test: "t", status: "passed" }], greenRatio: 1, flakyCount: 0 };
const config = loadConfig({ LLM_PROFILE: "openrouter", OPENROUTER_API_KEY: "test-key" });
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

/**
 * #250: Playwright reads the session file in every test, and its parse error quotes the file. Unread here, that text
 * would be every test's failure, and so the repair hint that goes to the model's provider.
 */
describe("runAutomate --validate: a session file Playwright could not read (#250)", () => {
  const LEAK = "COOKIE-SEC-q7";
  const damaged = `{"cookies":[{"name":"sid","value":${LEAK}}],"origins":[]}`;
  const failureOf = (input: Record<string, unknown>): Promise<string> =>
    runAutomate({ runDir, config, onProgress: () => undefined, ...input }).then(
      () => "(it ran)",
      (e: Error) => e.message,
    );

  it("--session-file: one line that names the file, before a call to the model or a test", async () => {
    const file = join(runDir, "bad.json");
    await writeFile(file, damaged, "utf8");
    const message = await failureOf({ validate: true, sessionFile: file });
    expect(message).toContain(`File '${file}' is not valid JSON`);
    expect(message).not.toContain("COOKIE-SEC");
    expect(automateCases).not.toHaveBeenCalled();
    expect(validateSuite).not.toHaveBeenCalled();
  });

  it("--session <name>: the same, for the file that name stands for", async () => {
    const file = join(runDir, "alice.storageState.json");
    await writeFile(file, damaged, "utf8");
    const message = await failureOf({ validate: true, sessionName: "alice", sessionsDir: runDir });
    expect(message).toContain(`File '${file}' is not valid JSON`);
    expect(automateCases).not.toHaveBeenCalled();
  });

  it("--session <name> with no such session says how to capture it", async () => {
    const message = await failureOf({ validate: true, sessionName: "nobody", sessionsDir: runDir });
    expect(message).toContain('No saved session "nobody"');
    expect(automateCases).not.toHaveBeenCalled();
  });

  it("a good file goes on to the run", async () => {
    const file = join(runDir, "good.json");
    await writeFile(file, JSON.stringify({ cookies: [{ name: "sid", value: "1", domain: "app.test", path: "/" }], origins: [] }), "utf8");
    validateSuite.mockResolvedValue(passing);
    expect(await failureOf({ validate: true, sessionFile: file })).toBe("(it ran)");
    expect(validateSuite.mock.calls[0]![1]).toMatchObject({ storageStatePath: file });
  });

  it("without --validate no test runs, so the file is not read", async () => {
    const file = join(runDir, "bad.json");
    await writeFile(file, damaged, "utf8");
    expect(await failureOf({ sessionFile: file })).toBe("(it ran)");
  });
});

/**
 * #250: `cairn automate --flows --validate` runs the fixture itself and puts the failures into the repair hint, which
 * goes to the model's provider. Only the browser run and the model are replaced here; the loop between them is real.
 */
describe("runAutomate --flows --validate: the values the flow file names (#250)", () => {
  const failing = (error: string) => ({ results: [{ test: "t", status: "failed", error }], greenRatio: 0, flakyCount: 0 });
  const flows = (path: string) => parseApiFlows(JSON.stringify({ version: 1, flows: [{ name: "thing", steps: [{ method: "GET", path }] }] }));

  const run = (path: string) => runAutomate({ runDir, config, validate: true, apiFlows: flows(path), onProgress: () => undefined });

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

describe("runAutomate with a mailbox session (ADR-0023 §4)", () => {
  const md = "---\nid: ATC-1\nexecution: auto\n---\n# ATC-1: Sign up\n\n## Steps\n\n1. Fill Email\n2. Enter the code from the email\n";

  it("a case step naming a code from the e-mail → the codegen gets the steps, the suite gets the fixture", async () => {
    await writeFile(join(runDir, "testcases", "ATC-1.md"), md, "utf8");
    const { MailboxSession, FakeMailbox } = await import("../../src/mailbox/index.js");
    const mailbox = new MailboxSession({ provider: new FakeMailbox(), runId: "r", env: {} });
    const out = await runAutomate({ runDir, config, mailbox, onProgress: () => undefined });
    expect(automateCases.mock.calls[0]![1].mailbox).toContain('"action":"mailbox.extractCode"');
    expect(out.specFiles.some((f) => f.endsWith("mailbox.fixture.ts"))).toBe(true);
  });

  it("no session → the codegen context and the suite are as before", async () => {
    await writeFile(join(runDir, "testcases", "ATC-1.md"), md, "utf8");
    const out = await runAutomate({ runDir, config, onProgress: () => undefined });
    expect(automateCases.mock.calls[0]![1].mailbox).toBeUndefined();
    expect(out.specFiles.some((f) => f.endsWith("mailbox.fixture.ts"))).toBe(false);
  });
});
