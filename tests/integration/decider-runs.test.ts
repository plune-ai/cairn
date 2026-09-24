import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { startFixtureServer, type FixtureServer } from "../fixtures/server.js";
import { makeGateway } from "../../src/browser/index.js";
import { runExploreGraph, type ExploreOutcome } from "../../src/agent/graph.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { renderReportMd } from "../../src/artifacts/report.js";
import { createEnvReader } from "../../src/config/env.js";
import { parseDeciderConfig } from "../../src/config/index.js";
import { makeDecider, writeShadowFile, deciderReportKeys, type Decider } from "../../src/decider/index.js";
import { checklistCoverageScore, judgeChecklistCoverage } from "../../src/eval/judge.js";
import { CostLedger } from "../../src/llm/cost.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { ValidationReport } from "../../src/validate/index.js";

/**
 * ADR-0022 / spec §10: the decider changes nothing unless it is on and active — proven on a real run of the
 * graph (real Chromium on the fixture site, a real artifact store), with the LLM replaced by a recorder that
 * keeps every prompt it is shown. If a single prompt differed, the models would answer differently.
 * Every use point runs: repair-triage and locator-heal inside the graph, checklist coverage after it (as
 * runExploration does), and report.json carries the run's own cost ledger — which a shadow decider must not touch.
 */
const BASE = join(process.cwd(), "runs", ".itest-decider");
const CHECKLIST = [{ text: "A user can sign in with valid credentials" }];

const sampleCase = {
  title: "signs in",
  technique: "exploratory",
  kind: "static",
  type: "Positive",
  execution: "auto",
  preconditions: [],
  steps: ["open the page", "press Sign In"],
  expected: "the user is signed in",
  priority: "high",
  elementRefs: [],
};

const WELCOME = "Error: expect(locator).toBeVisible() failed\nLocator: getByRole('heading', { name: 'Welcome' })\nTimeout: 5000ms";
/** The login button renamed: the test still waits for `Log in`, the fixture page's one button says `Sign In`. */
const LOG_IN =
  "Test timeout of 30000ms exceeded.\n\nError: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Log in' })";

/** Fails the first run the way Playwright does; the repair turns it green. */
function scriptedValidate(error = WELCOME): () => Promise<ValidationReport> {
  let n = 0;
  return async () =>
    n++ === 0
      ? {
          results: [{ test: "signs in", status: "failed", error }],
          greenRatio: 0,
          flakyCount: 0,
        }
      : { results: [{ test: "signs in", status: "passed" }], greenRatio: 1, flakyCount: 0 };
}

const recording = (value: unknown, log: string[]): StructuredInvoke =>
  (async (_schema: unknown, messages: unknown) => {
    log.push(JSON.stringify(messages));
    return value;
  }) as unknown as StructuredInvoke;

/**
 * A Jev-compatible server. "confident" answers every choice with app-bug (or its first label) and every noul
 * with yes, at high confidence — the worst case for a shadow run that must change nothing. "healer" answers as a
 * right decider would about the renamed button: triage `locator-missing`, the heal the option naming `"Sign In"`.
 * "dead" answers 500.
 */
async function fakeSystemOne(mode: "confident" | "healer" | "dead") {
  let requests = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      requests += 1;
      if (mode === "dead") {
        res.statusCode = 500;
        res.end("{}");
        return;
      }
      const questions = (JSON.parse(body) as { questions: Record<string, { type: string; criteria: unknown }> }).questions;
      const answers = Object.fromEntries(
        Object.entries(questions).map(([k, q]) => {
          if (q.type === "noul") return [k, { type: "noul", noul: 0.97 }];
          const criteria = q.criteria as Record<string, string>;
          const labels = Object.keys(criteria);
          const right = labels.includes("locator-missing") ? "locator-missing" : labels.find((l) => criteria[l]?.includes('"Sign In"'));
          const pick = mode === "healer" && right ? right : labels.includes("app-bug") ? "app-bug" : (labels[0] ?? "a");
          return [k, { type: "choice", choice: pick, probabilities: { [pick]: 0.97 }, confidence: 0.95 }];
        }),
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "fake-jev", answers, usage: { input_tokens: 10, output_tokens: 0 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests: (): number => requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Variant {
  out: ExploreOutcome;
  prompts: string[];
  dir: string;
  decider?: Decider;
}

/** A run as runExploration builds it: the decider from env through the one factory, over the run's own ledger. */
async function runVariant(
  name: string,
  env: Record<string, string> | undefined,
  siteUrl: string,
  error?: string,
): Promise<Variant> {
  const prompts: string[] = [];
  const ledger = new CostLedger();
  const decider = env ? makeDecider(parseDeciderConfig(createEnvReader(env, () => undefined)), { ledger }) : undefined;
  const registry = new PromptRegistry();
  const runWriter = await new ArtifactStore(join(BASE, name)).openRun("run");
  const gateway = makeGateway({ backend: "lib", headless: true });
  try {
    const out = await runExploreGraph(
      {
        gateway,
        prompts: registry,
        analyzeInvoke: recording({ pageSemantics: "A sign-in page", primaryRefs: [], viewSwitchers: [] }, prompts),
        designInvoke: recording({ testCases: [sampleCase] }, prompts),
        codegenInvoke: recording({ files: [{ path: "signin.spec.ts", content: "// generated" }] }, prompts),
        useVision: false,
        runWriter,
        validate: scriptedValidate(error),
        maxRepair: 2,
        decider,
      },
      { url: `${siteUrl}/login.html`, runId: "run" },
    );
    const judge = recording({ coverage: 0.5, uncovered: [CHECKLIST[0]!.text] }, prompts);
    const coverage = await checklistCoverageScore(
      CHECKLIST,
      out.testCases,
      () => judgeChecklistCoverage(CHECKLIST, out.testCases, judge, registry),
      decider,
    );
    // What runExploration writes around the graph, with the same helpers.
    const keys = deciderReportKeys(decider, out.notRepaired, out.healed);
    const common = { testCases: out.testCases, validation: out.validation, scores: [coverage], cost: ledger.report(), ...keys };
    await runWriter.writeReport({ url: out.study.url, ...common });
    await runWriter.writeReportMd(
      renderReportMd({
        runId: "run",
        url: out.study.url,
        backend: "lib",
        profile: "test",
        pageSemantics: out.analysis.pageSemantics,
        elements: out.study.elements,
        ...common,
      }),
    );
    await writeShadowFile(runWriter.dir, decider);
    return { out, prompts, dir: runWriter.dir, ...(decider ? { decider } : {}) };
  } finally {
    await gateway.close();
  }
}

async function filesUnder(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d)) {
      const p = join(d, e);
      if ((await stat(p)).isDirectory()) await walk(p);
      else files[relative(dir, p).replace(/\\/g, "/")] = await readFile(p, "utf8");
    }
  };
  await walk(dir);
  return files;
}

describe("decision layer on a real run (integration, real Chromium, no LLM)", () => {
  let site: FixtureServer;
  let confident: Awaited<ReturnType<typeof fakeSystemOne>>;
  let dead: Awaited<ReturnType<typeof fakeSystemOne>>;
  let healer: Awaited<ReturnType<typeof fakeSystemOne>>;
  let baseline: Variant;

  beforeAll(async () => {
    await rm(BASE, { recursive: true, force: true });
    site = await startFixtureServer();
    confident = await fakeSystemOne("confident");
    dead = await fakeSystemOne("dead");
    healer = await fakeSystemOne("healer");
    baseline = await runVariant("A-no-decider", undefined, site.url);
  }, 120_000);

  afterAll(async () => {
    await site.close();
    await confident.close();
    await dead.close();
    await healer.close();
    await rm(BASE, { recursive: true, force: true });
  });

  it("the baseline repairs once and judges coverage: the prompts carry the failure and the checklist", async () => {
    expect(baseline.out.attempts).toBe(1);
    expect(baseline.out.validation?.greenRatio).toBe(1);
    const repair = baseline.prompts.find((p) => p.includes("expect(locator).toBeVisible() failed"));
    expect(repair).toContain("signs in");
    expect(baseline.prompts.at(-1)).toContain(CHECKLIST[0]!.text); // the coverage judge ran last
    expect(JSON.parse((await filesUnder(baseline.dir))["report.json"] ?? "{}")).toMatchObject({
      scores: [{ name: "checklist_coverage", value: 0.5 }],
    });
  });

  it("DECIDER=off is no decider at all: identical prompts, identical files", async () => {
    const b = await runVariant("B-off", { DECIDER: "off", TYPESAFE_API_KEY: "k" }, site.url);
    expect(b.decider).toBeUndefined();
    expect(b.prompts).toEqual(baseline.prompts);
    expect(await filesUnder(b.dir)).toEqual(await filesUnder(baseline.dir));
  }, 120_000);

  it("shadow: a decider sure of everything changes no prompt and no file (cost included) — it only writes decider-shadow.json", async () => {
    const before = confident.requests();
    const c = await runVariant("C-shadow", { DECIDER: "compat", DECIDER_BASE_URL: confident.url, DECIDER_SHADOW: "1" }, site.url);
    expect(confident.requests()).toBeGreaterThan(before); // it WAS asked

    expect(c.prompts).toEqual(baseline.prompts);
    const { ["decider-shadow.json"]: shadowFile, ...rest } = await filesUnder(c.dir);
    expect(rest).toEqual(await filesUnder(baseline.dir)); // report.json's cost too: the decider metered privately

    const log = JSON.parse(shadowFile ?? "{}") as { entries: { use: string }[]; cost?: { perRole: unknown[] } };
    expect(log.entries.find((e) => e.use === "repair-triage")).toMatchObject({
      current: "repair",
      decider: { category: "app-bug", wouldExclude: true },
    });
    expect(log.entries.find((e) => e.use === "coverage")).toMatchObject({
      current: { value: 0.5, source: "judge" },
      decider: { value: 1 },
      agreement: 0,
    });
    expect(log.cost?.perRole).toHaveLength(1); // the private ledger holds the decider's calls
  }, 120_000);

  it("active: the same confident app bug keeps the test out of repair, the decider scores coverage — and the report says so", async () => {
    // coverage acts only when asked for by name (an active decider defaults to repair-triage alone)
    const both = { DECIDER_USES: "repair-triage,coverage" };
    const e = await runVariant("E-active", { DECIDER: "compat", DECIDER_BASE_URL: confident.url, ...both }, site.url);
    expect(e.out.attempts).toBe(0); // no repair was spent on an app bug
    expect(e.out.notRepaired).toEqual([expect.objectContaining({ test: "signs in", category: "app-bug", exclude: true })]);
    const files = await filesUnder(e.dir);
    expect(files["report.md"]).toContain("## Not repaired — likely an app bug or a broken environment (1)");
    expect(files["report.md"]).toContain("decider (compat): full coverage");
    expect(JSON.parse(files["report.json"] ?? "{}")).toMatchObject({ decider: { provider: "compat", calls: 2, fallbacks: [] } });
  }, 120_000);

  it("shadow heal: Chromium checks the pick on the page, and still no prompt or file changes", async () => {
    const f = await runVariant("F-no-decider-heal", undefined, site.url, LOG_IN);
    const g = await runVariant("G-shadow-heal", { DECIDER: "compat", DECIDER_BASE_URL: healer.url, DECIDER_SHADOW: "1" }, site.url, LOG_IN);
    expect(g.prompts).toEqual(f.prompts);
    const { ["decider-shadow.json"]: shadowFile, ...rest } = await filesUnder(g.dir);
    expect(rest).toEqual(await filesUnder(f.dir));
    const log = JSON.parse(shadowFile ?? "{}") as { entries: { use: string }[] };
    expect(log.entries.find((e) => e.use === "locator-heal")).toMatchObject({
      input: { candidates: ['button "Sign In"'] },
      // verified: the fixture page, in Chromium, has exactly one element the replacement matches
      decider: { to: "getByRole('button', { name: 'Sign In', exact: true })", verified: true },
    });
  }, 240_000);

  it("active heal: the replacement Chromium matched once goes into the repair hint, and the report lists it", async () => {
    const env = { DECIDER: "compat", DECIDER_BASE_URL: healer.url, DECIDER_USES: "repair-triage,locator-heal" };
    const h = await runVariant("H-active-heal", env, site.url, LOG_IN);
    const from = "getByRole('button', { name: 'Log in' })";
    const to = "getByRole('button', { name: 'Sign In', exact: true })";
    expect(h.out.healed).toEqual([{ test: "signs in", from, to, confidence: 0.95 }]);
    expect(h.prompts.find((p) => p.includes("waiting for getByRole"))).toContain(`→ replace ${from} with ${to} (verified: 1 match)`);
    expect((await filesUnder(h.dir))["report.md"]).toContain("## Locators healed (1)");
  }, 120_000);

  it("a dead decider (HTTP 500 on every call) never sinks the run: it repairs and judges exactly as without one, and the report shows the fallbacks", async () => {
    const d = await runVariant("D-dead", { DECIDER: "compat", DECIDER_BASE_URL: dead.url, DECIDER_USES: "repair-triage,coverage" }, site.url);
    expect(d.out.validation?.greenRatio).toBe(1);
    expect(d.out.attempts).toBe(1);
    expect(d.prompts).toEqual(baseline.prompts); // the repair hint and the judge prompt are today's, byte for byte
    const summary = d.decider!.summary();
    expect(summary.fallbacks.map((f) => f.use).sort()).toEqual(["coverage", "repair-triage"]);
    expect(summary.fallbacks.every((f) => f.reason === "HTTP 500")).toBe(true);
    expect(dead.requests()).toBe(2 * summary.calls); // one retry per call on a 5xx, never more
    const files = await filesUnder(d.dir);
    expect(JSON.parse(files["report.json"] ?? "{}")).toMatchObject({ decider: { fallbacks: summary.fallbacks } });
    expect(files["report.md"]).toContain("## Decision layer");
    expect(files["report.md"]).toMatch(/HTTP 500/);
  }, 120_000);
});
