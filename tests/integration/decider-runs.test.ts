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
import { CostLedger } from "../../src/llm/cost.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { ValidationReport } from "../../src/validate/index.js";

/**
 * ADR-0022 / spec §10: the decider changes nothing unless it is on and active — proven on a real run of the
 * graph (real Chromium on the fixture site, a real artifact store), with the LLM replaced by a recorder that
 * keeps every prompt it is shown. If a single prompt differed, the models would answer differently.
 */
const BASE = join(process.cwd(), "runs", ".itest-decider");

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

/** Fails the first run the way Playwright does; the repair turns it green. */
function scriptedValidate(): () => Promise<ValidationReport> {
  let n = 0;
  return async () =>
    n++ === 0
      ? {
          results: [
            {
              test: "signs in",
              status: "failed",
              error: "Error: expect(locator).toBeVisible() failed\nLocator: getByRole('heading', { name: 'Welcome' })\nTimeout: 5000ms",
            },
          ],
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
 * with yes, at high confidence — the worst case for a shadow run that must change nothing. "dead" answers 500.
 */
async function fakeSystemOne(mode: "confident" | "dead") {
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
          const labels = Object.keys(q.criteria as Record<string, unknown>);
          const pick = labels.includes("app-bug") ? "app-bug" : (labels[0] ?? "a");
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

/** A decider exactly as a run builds it: from env, through the one factory. */
const deciderFrom = (env: Record<string, string>): Decider | undefined =>
  makeDecider(parseDeciderConfig(createEnvReader(env, () => undefined)), { ledger: new CostLedger() });

interface Variant {
  out: ExploreOutcome;
  prompts: string[];
  dir: string;
}

async function runVariant(name: string, decider: Decider | undefined, siteUrl: string): Promise<Variant> {
  const prompts: string[] = [];
  const runWriter = await new ArtifactStore(join(BASE, name)).openRun("run");
  const gateway = makeGateway({ backend: "lib", headless: true });
  try {
    const out = await runExploreGraph(
      {
        gateway,
        prompts: new PromptRegistry(),
        analyzeInvoke: recording({ pageSemantics: "A sign-in page", primaryRefs: [], viewSwitchers: [] }, prompts),
        designInvoke: recording({ testCases: [sampleCase] }, prompts),
        codegenInvoke: recording({ files: [{ path: "signin.spec.ts", content: "// generated" }] }, prompts),
        useVision: false,
        runWriter,
        validate: scriptedValidate(),
        maxRepair: 2,
        decider,
      },
      { url: `${siteUrl}/login.html`, runId: "run" },
    );
    // What runExploration writes around the graph, with the same helpers.
    const keys = deciderReportKeys(decider, out.notRepaired);
    await runWriter.writeReport({ url: out.study.url, testCases: out.testCases, validation: out.validation, ...keys });
    await runWriter.writeReportMd(
      renderReportMd({
        runId: "run",
        url: out.study.url,
        backend: "lib",
        profile: "test",
        pageSemantics: out.analysis.pageSemantics,
        elements: out.study.elements,
        testCases: out.testCases,
        validation: out.validation,
        ...keys,
      }),
    );
    await writeShadowFile(runWriter.dir, decider);
    return { out, prompts, dir: runWriter.dir };
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
  let baseline: Variant;

  beforeAll(async () => {
    await rm(BASE, { recursive: true, force: true });
    site = await startFixtureServer();
    confident = await fakeSystemOne("confident");
    dead = await fakeSystemOne("dead");
    baseline = await runVariant("A-no-decider", undefined, site.url);
  }, 120_000);

  afterAll(async () => {
    await site.close();
    await confident.close();
    await dead.close();
    await rm(BASE, { recursive: true, force: true });
  });

  it("the baseline repairs once: the second codegen prompt carries the failure", () => {
    expect(baseline.out.attempts).toBe(1);
    expect(baseline.out.validation?.greenRatio).toBe(1);
    expect(baseline.prompts.at(-1)).toContain("signs in");
    expect(baseline.prompts.at(-1)).toContain("toBeVisible");
  });

  it("DECIDER=off is no decider at all: identical prompts, identical files", async () => {
    const off = deciderFrom({ DECIDER: "off", TYPESAFE_API_KEY: "k" });
    expect(off).toBeUndefined();
    const b = await runVariant("B-off", off, site.url);
    expect(b.prompts).toEqual(baseline.prompts);
    expect(await filesUnder(b.dir)).toEqual(await filesUnder(baseline.dir));
  }, 120_000);

  it("shadow: a decider sure that the failure is an app bug changes no prompt and no file — it only writes decider-shadow.json", async () => {
    const shadow = deciderFrom({ DECIDER: "jev", TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: confident.url, DECIDER_SHADOW: "1" });
    const before = confident.requests();
    const c = await runVariant("C-shadow", shadow, site.url);
    expect(confident.requests()).toBeGreaterThan(before); // it WAS asked

    expect(c.prompts).toEqual(baseline.prompts);
    const { ["decider-shadow.json"]: shadowFile, ...rest } = await filesUnder(c.dir);
    expect(rest).toEqual(await filesUnder(baseline.dir));

    const log = JSON.parse(shadowFile ?? "{}") as { entries: { use: string; current: string; decider: unknown }[] };
    const triage = log.entries.filter((e) => e.use === "repair-triage");
    expect(triage.length).toBeGreaterThanOrEqual(1);
    expect(triage[0]).toMatchObject({ current: "repair", decider: { category: "app-bug", wouldExclude: true } });
  }, 120_000);

  it("active: the same confident app bug keeps the test out of repair — and the report says so", async () => {
    const active = deciderFrom({ DECIDER: "jev", TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: confident.url });
    const e = await runVariant("E-active", active, site.url);
    expect(e.out.attempts).toBe(0); // no repair was spent on an app bug
    expect(e.out.notRepaired).toEqual([expect.objectContaining({ test: "signs in", category: "app-bug", exclude: true })]);
    const files = await filesUnder(e.dir);
    expect(files["report.md"]).toContain("## Not repaired — likely an app bug or a broken environment (1)");
    expect(JSON.parse(files["report.json"] ?? "{}")).toMatchObject({ decider: { provider: "jev", calls: 1, fallbacks: [] } });
  }, 120_000);

  it("a dead decider (HTTP 500 on every call) never sinks the run: it repairs exactly as without one", async () => {
    const active = deciderFrom({ DECIDER: "jev", TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: dead.url });
    const d = await runVariant("D-dead", active, site.url);
    expect(d.out.validation?.greenRatio).toBe(1);
    expect(d.out.attempts).toBe(1);
    expect(d.prompts).toEqual(baseline.prompts); // the repair hint is today's, byte for byte
    const summary = active!.summary();
    expect(summary.fallbacks.length).toBeGreaterThan(0);
    expect(summary.fallbacks.every((f) => f.reason === "HTTP 500")).toBe(true);
    expect(dead.requests()).toBe(2 * summary.calls); // one retry per call on a 5xx, never more
  }, 120_000);
});
