import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import { runDesign, runExploration } from "../../src/agent/index.js";
import { reportableTraceUrl, resolveTraceUrl } from "../../src/telemetry/index.js";
import { withTraceUrl } from "../../src/artifacts/contract.js";

// The trace link a run writes into report.json: the tracing SDK gives the address (base URL + project + trace id),
// and only a plain https address without credentials or keys reaches the report.

const PUBLIC_KEY = "pk-lf-test-public";
const SECRET_KEY = "sk-lf-test-secret";
/** What the SDK's own lookup returns for a base URL: `<base>/project/<project>/traces/<trace>`. */
const sdkLookup = (baseUrl: string) => async (traceId: string) => `${baseUrl}/project/proj-1/traces/${traceId}`;

function resolveWith(over: Partial<Parameters<typeof resolveTraceUrl>[0]>): Promise<{ url: string | undefined; lines: string[] }> {
  const lines: string[] = [];
  return resolveTraceUrl({
    traceId: "0af7651916cd43dd8448eb211c80319c",
    lookup: sdkLookup("https://cloud.langfuse.com"),
    keys: [PUBLIC_KEY, SECRET_KEY],
    warn: (l) => lines.push(l),
    ...over,
  }).then((url) => ({ url, lines }));
}

describe("resolveTraceUrl · the address of the run's trace", () => {
  it("gives the cloud address, with no line", async () => {
    const { url, lines } = await resolveWith({});
    expect(url).toBe("https://cloud.langfuse.com/project/proj-1/traces/0af7651916cd43dd8448eb211c80319c");
    expect(lines).toEqual([]);
  });

  it("gives the self-hosted address, under a sub-path and with a trailing slash in the base URL", async () => {
    const { url } = await resolveWith({ lookup: sdkLookup("https://langfuse.example.test/obs/") });
    expect(url).toBe("https://langfuse.example.test/obs/project/proj-1/traces/0af7651916cd43dd8448eb211c80319c");
  });

  it("gives nothing and says so once when the project cannot be looked up", async () => {
    const { url, lines } = await resolveWith({
      lookup: async () => {
        throw new Error(`401 for ${SECRET_KEY} at https://cloud.langfuse.com/api/public/projects?page=1`);
      },
    });
    expect(url).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/trace link/);
    expect(lines[0]).not.toContain(SECRET_KEY);
    expect(lines[0]).not.toContain("?page=1");
  });

  it("gives nothing and says so once when the lookup does not answer in time", async () => {
    const { url, lines } = await resolveWith({ lookup: () => new Promise<string>(() => undefined), timeoutMs: 10 });
    expect(url).toBeUndefined();
    expect(lines).toHaveLength(1);
  });

  it("gives nothing and says so once when there is no active trace", async () => {
    const { url, lines } = await resolveWith({ traceId: undefined });
    expect(url).toBeUndefined();
    expect(lines).toHaveLength(1);
  });

  it.each([
    ["an http address", "http://langfuse.local:3000"],
    ["a user and password", "https://user:hunter2@langfuse.example.test"],
    ["an address over 2048 characters", `https://langfuse.example.test/${"a".repeat(2100)}`],
    ["the secret key", `https://langfuse.example.test/${SECRET_KEY}`],
    ["the public key", `https://langfuse.example.test/${PUBLIC_KEY}`],
    ["a query", "https://langfuse.example.test/?token=abc"],
    ["a fragment", "https://langfuse.example.test/#token=abc"],
    ["the secret key percent-encoded", `https://langfuse.example.test/${SECRET_KEY.replaceAll("-", "%2D")}`],
    ["the secret key in upper case", `https://langfuse.example.test/${SECRET_KEY.toUpperCase()}`],
  ])("writes no link for %s, and the one line shows neither the address nor a key", async (_what, baseUrl) => {
    const { url, lines } = await resolveWith({ lookup: sdkLookup(baseUrl) });
    expect(url).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/hunter2|proj-1|langfuse\.example|token|sk.lf|pk.lf/i);
  });
});

describe("reportableTraceUrl · what may go into the report", () => {
  it("keeps a plain https address", () => {
    expect(reportableTraceUrl("https://us.cloud.langfuse.com/project/p/traces/t")).toBe("https://us.cloud.langfuse.com/project/p/traces/t");
  });

  it.each(["", "not an address", "ftp://host/x", "https://u@host/x", "http://host/x"])("refuses %j", (raw) => {
    expect(reportableTraceUrl(raw)).toBeUndefined();
  });

  it.each([
    ["as it is", SECRET_KEY],
    ["percent-encoded", SECRET_KEY.replaceAll("-", "%2D")],
    ["in upper case", SECRET_KEY.toUpperCase()],
  ])("never returns an address that holds a key %s", (_how, key) => {
    expect(reportableTraceUrl(`https://host/project/${key}/traces/t`, [PUBLIC_KEY, SECRET_KEY])).toBeUndefined();
  });

  it.each(["https://host/project/p/traces/t?token=abc", "https://host/project/p/traces/t#frag", "https://host/project/%E0%A4%A/traces/t"])(
    "refuses %j: a query, a fragment, or a path that does not decode",
    (raw) => {
      expect(reportableTraceUrl(raw, [SECRET_KEY])).toBeUndefined();
    },
  );
});

describe("withTraceUrl · the field on each case", () => {
  const cases = [{ id: "tc-1", title: "a" }, { id: "tc-2", title: "b" }];

  it("puts the link on every case", () => {
    expect(withTraceUrl(cases, "https://h/project/p/traces/t")).toEqual([
      { id: "tc-1", title: "a", traceUrl: "https://h/project/p/traces/t" },
      { id: "tc-2", title: "b", traceUrl: "https://h/project/p/traces/t" },
    ]);
  });

  it("leaves the cases without the key when there is no link", () => {
    const out = withTraceUrl(cases, undefined);
    expect(out).toEqual(cases);
    expect(out.some((c) => "traceUrl" in c)).toBe(false);
  });
});

describe("initTelemetry · tracing off", () => {
  it("offers no trace link", async () => {
    // The real function: this file's mock of the telemetry module replaces `initTelemetry` for the runs below.
    const { initTelemetry } = await vi.importActual<typeof import("../../src/telemetry/index.js")>("../../src/telemetry/index.js");
    const tel = await initTelemetry(loadConfig({ ANTHROPIC_API_KEY: "test-key-not-used" }));
    expect(tel.enabled).toBe(false);
    expect(tel.traceUrl).toBeUndefined();
  });
});

// --- report.json, as `design` writes it. No browser and no model: the graph, the preflight, the gateway and the
// judge are stubbed, and the telemetry is a fake whose trace link each test sets.
const fake = vi.hoisted(() => ({
  traceUrl: undefined as undefined | ((warn: (line: string) => void) => Promise<string | undefined>),
  /** A fake Langfuse client: set, the run has a trace id and somewhere to send its scores. */
  client: undefined as undefined | { score: { create: (body: Record<string, unknown>) => void } },
}));
vi.mock("../../src/telemetry/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/telemetry/index.js")>()),
  initTelemetry: async () => ({
    enabled: fake.traceUrl !== undefined || fake.client !== undefined,
    shutdown: async () => undefined,
    runInTrace: (_n: string, _m: unknown, fn: () => Promise<unknown>) => fn(),
    ...(fake.traceUrl ? { traceUrl: fake.traceUrl } : {}),
    ...(fake.client ? { client: fake.client, callbackHandler: { last_trace_id: "trace-321" } } : {}),
  }),
}));
vi.mock("../../src/browser/preflight.js", () => ({ ensureBrowsersInstalled: () => undefined }));
vi.mock("../../src/browser/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/browser/index.js")>()),
  makeGateway: () => ({ close: async () => undefined }),
}));
vi.mock("../../src/eval/judge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/eval/judge.js")>()),
  judgeTestCases: async () => [],
}));
vi.mock("../../src/eval/pilot.js", async (orig) => ({
  ...(await orig<typeof import("../../src/eval/pilot.js")>()),
  pilotReview: async () => {
    throw new Error("no model in this test");
  },
}));
vi.mock("../../src/agent/graph.js", () => ({
  runExploreGraph: async () => ({
    study: { url: "https://app.test/login", screenshotB64: "", ariaYaml: "", capturedBy: "lib", elements: [] },
    analysis: { pageSemantics: "A login page", primaryRefs: [], viewSwitchers: [] },
    verified: [],
    transitions: [],
    testCases: ["loads the page", "shows the form"].map((title, i) => ({
      id: `tc-${i + 1}`,
      title,
      technique: "exploratory",
      kind: "static",
      type: "Positive",
      execution: "auto",
      preconditions: [],
      steps: ["open the page"],
      expected: "the page renders",
      priority: "high",
      elementRefs: [],
    })),
    suite: { files: [] },
    stoppedEarly: false,
    attempts: 0,
    clicks: [],
  }),
}));

const base = await mkdtemp(join(tmpdir(), "cairn-trace-url-"));
afterAll(() => rm(base, { recursive: true, force: true }));

async function runReport(run: typeof runDesign | typeof runExploration): Promise<{ raw: string; cases: Record<string, unknown>[]; progress: string[] }> {
  const progress: string[] = [];
  const config = loadConfig({ ANTHROPIC_API_KEY: "test-key-not-used" });
  const result = await run({
    url: "https://app.test/login",
    config,
    runsBaseDir: base,
    knowledgeDir: join(base, "none"),
    onProgress: (l) => progress.push(l),
  });
  const raw = await readFile(join(result.runDir, "report.json"), "utf8");
  return { raw, cases: (JSON.parse(raw) as { testCases: Record<string, unknown>[] }).testCases, progress };
}

describe.each([
  ["design", runDesign],
  ["explore", runExploration],
] as const)("%s report.json · traceUrl", (_mode, run) => {
  it("each case carries the run's trace link when tracing gives one", async () => {
    fake.traceUrl = async () => "https://cloud.langfuse.com/project/proj-1/traces/abc";
    const { cases } = await runReport(run);
    expect(cases.map((c) => c["traceUrl"])).toEqual([
      "https://cloud.langfuse.com/project/proj-1/traces/abc",
      "https://cloud.langfuse.com/project/proj-1/traces/abc",
    ]);
  });

  it("no case has the key when tracing is off", async () => {
    fake.traceUrl = undefined;
    const { raw } = await runReport(run);
    expect(raw).not.toContain("traceUrl");
  });

  it("no case has the key when the link could not be built, and the run says so once", async () => {
    fake.traceUrl = (warn) => resolveTraceUrl({ traceId: "abc", lookup: sdkLookup("http://langfuse.local:3000"), warn });
    const { raw, progress } = await runReport(run);
    expect(raw).not.toContain("traceUrl");
    expect(progress.filter((l) => /trace link/.test(l))).toHaveLength(1);
  });
});

// #321: `design` sent no score to Langfuse while `explore` did — both send every metric of the report.
describe.each([
  ["design", runDesign],
  ["explore", runExploration],
] as const)("%s · scores reach Langfuse", (_mode, run) => {
  it("sends each metric of the report once, against the run's trace", async () => {
    const create = vi.fn();
    fake.traceUrl = undefined;
    fake.client = { score: { create } };
    try {
      const { raw } = await runReport(run);
      const scores = (JSON.parse(raw) as { scores: { name: string; value: number }[] }).scores;
      expect(scores.length).toBeGreaterThan(0);
      expect(create.mock.calls.map(([b]) => [b.traceId, b.name, b.value, b.dataType])).toEqual(
        scores.map((sc) => ["trace-321", sc.name, sc.value, "NUMERIC"]),
      );
    } finally {
      fake.client = undefined;
    }
  });
});
