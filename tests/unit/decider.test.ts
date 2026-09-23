import { describe, it, expect, vi } from "vitest";
import { makeDecider, dataDestination } from "../../src/decider/index.js";
import { secretValues, redact } from "../../src/decider/redact.js";
import { CostLedger } from "../../src/llm/cost.js";
import type { DecisionTrace } from "../../src/telemetry/index.js";
import { DeciderUnavailable, type DeciderConfig, type Question } from "../../src/decider/types.js";

const cfg = (over: Partial<DeciderConfig> = {}): DeciderConfig => ({
  provider: "jev",
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  apiKey: "k",
  uses: ["repair-triage", "coverage"],
  minConfidence: 0.75,
  timeoutMs: 1000,
  maxCalls: 10,
  ...over,
});
const localLaya = { provider: "laya" as const, baseUrl: "http://127.0.0.1:8000" };
const q: Question = { type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "no" } };
const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const jevOk = (usage: unknown = { input_tokens: 1_000_000, output_tokens: 5 }) =>
  respond({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.95 } }, usage });
const layaOk = respond({
  model: "laya-rl-agent",
  answers: { q: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.5 } },
  usage: { input_tokens: 10, output_tokens: 0 },
});
const sentBody = (fetchFn: typeof fetch): { state: string } =>
  JSON.parse(String((fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body));

// FIRST in the file: the "once per process" flag is module state, and every later test builds remote deciders.
describe("where the data goes", () => {
  it("warns once per process when data leaves the machine; never for localhost", () => {
    const warn = vi.fn();
    makeDecider(cfg(localLaya), { ledger: new CostLedger(), warn });
    expect(warn).not.toHaveBeenCalled();
    makeDecider(cfg(), { ledger: new CostLedger(), warn });
    makeDecider(cfg(), { ledger: new CostLedger(), warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/TypeSafe cloud.*DECIDER=laya/);
  });

  it.each([
    ["http://127.0.0.1:8000", true, "this machine"],
    ["http://localhost:9000", true, "this machine"],
    ["http://[::1]:8000", true, "this machine"],
    ["https://api.typesafe.ai", false, "TypeSafe cloud"],
    ["https://laya.example.com", false, "laya.example.com"],
  ])("dataDestination(%s)", (url, local, label) => {
    expect(dataDestination(url).local).toBe(local);
    expect(dataDestination(url).label).toContain(label);
  });
});

describe("makeDecider", () => {
  it("no config → undefined: nothing downstream can even reach a decider", () => {
    expect(makeDecider(undefined, { ledger: new CostLedger() })).toBeUndefined();
  });

  it("exposes what use points need: provider, model, caps, uses, threshold", () => {
    const d = makeDecider(cfg(localLaya), { ledger: new CostLedger() })!;
    expect(d.provider).toBe("laya");
    expect(d.model).toBe("jev-latest");
    expect(d.caps.maxStateChars).toBe(1200);
    expect([...d.uses]).toEqual(["repair-triage", "coverage"]);
    expect(d.minConfidence).toBe(0.75);
  });

  it("a successful call is priced into the ledger under the `decider` role (jev: $0.042 per 1M input)", async () => {
    const ledger = new CostLedger();
    const d = makeDecider(cfg(), { ledger, fetchFn: jevOk(), warn: () => undefined })!;
    const answers = await d.decide("coverage", "S", { q });
    expect(answers.q).toMatchObject({ type: "noul", value: true });
    expect(ledger.report().perRole).toEqual([
      expect.objectContaining({ role: "decider", calls: 1, inputTokens: 1_000_000, outputTokens: 5, costUsd: 0.042 }),
    ]);
  });

  it("laya is free; compat has no known price (n/a, tokens still counted)", async () => {
    const free = new CostLedger();
    await makeDecider(cfg(localLaya), { ledger: free, fetchFn: layaOk })!.decide("coverage", "S", { q });
    expect(free.report().perRole[0]).toMatchObject({ role: "decider", costUsd: 0, inputTokens: 10 });

    const unknown = new CostLedger();
    const compat = makeDecider(cfg({ provider: "compat", baseUrl: "http://127.0.0.1:9000" }), {
      ledger: unknown,
      fetchFn: respond({ answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 7, output_tokens: 0 } }),
    })!;
    await compat.decide("coverage", "S", { q });
    expect(unknown.report().perRole[0]).toMatchObject({ role: "decider", costUsd: null, inputTokens: 7 });
  });

  it("no usage reported → a rough estimate is recorded instead of nothing", async () => {
    const ledger = new CostLedger();
    const d = makeDecider(cfg(), { ledger, fetchFn: respond({ answers: { q: { type: "noul", noul: 0.9 } } }) })!;
    await d.decide("coverage", "x".repeat(400), { q });
    expect(ledger.report().perRole[0]!.inputTokens).toBeGreaterThanOrEqual(100);
  });

  it("any failure is DeciderUnavailable, traced as a fallback with its reason, and never priced", async () => {
    const ledger = new CostLedger();
    const traces: DecisionTrace[] = [];
    const d = makeDecider(cfg(), {
      ledger,
      warn: () => undefined,
      telemetry: { recordDecision: (t) => void traces.push(t) },
      fetchFn: respond({}, 500),
    })!;
    await expect(d.decide("coverage", "S", { q })).rejects.toBeInstanceOf(DeciderUnavailable);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ use: "coverage", provider: "jev", fallback: true, reason: "HTTP 500" });
    expect(ledger.report().perRole).toEqual([]);
  });

  it("a success is traced with the answering model, the answers and the threshold", async () => {
    const traces: DecisionTrace[] = [];
    const d = makeDecider(cfg(), { ledger: new CostLedger(), fetchFn: jevOk(), telemetry: { recordDecision: (t) => void traces.push(t) } })!;
    await d.decide("repair-triage", "S", { q });
    expect(traces[0]).toMatchObject({
      use: "repair-triage",
      model: "jev-1.13.0",
      fallback: false,
      minConfidence: 0.75,
      state: "S",
      answers: { q: { type: "noul", value: true } },
    });
    expect(traces[0]!.endTime.getTime()).toBeGreaterThanOrEqual(traces[0]!.startTime.getTime());
  });

  it("caps are checked before the request: an over-long state never reaches fetch", async () => {
    const fetchFn = layaOk;
    (fetchFn as unknown as { mockClear: () => void }).mockClear();
    const d = makeDecider(cfg(localLaya), { ledger: new CostLedger(), fetchFn })!;
    await expect(d.decide("coverage", "x".repeat(1201), { q })).rejects.toBeInstanceOf(DeciderUnavailable);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the per-run call ceiling holds across decide() calls", async () => {
    const d = makeDecider(cfg({ maxCalls: 1 }), { ledger: new CostLedger(), fetchFn: jevOk() })!;
    await d.decide("coverage", "S", { q });
    await expect(d.decide("coverage", "S", { q })).rejects.toThrow(/ceiling/);
  });

  it("secrets are scrubbed from the state before it leaves the process — and from the trace", async () => {
    const fetchFn = jevOk();
    const traces: DecisionTrace[] = [];
    const d = makeDecider(cfg(), {
      ledger: new CostLedger(),
      fetchFn,
      secrets: ["Sup3rS3cret!"],
      telemetry: { recordDecision: (t) => void traces.push(t) },
    })!;
    await d.decide("coverage", "type Sup3rS3cret! into Password", { q });
    expect(sentBody(fetchFn).state).toBe("type ‹redacted› into Password");
    expect(traces[0]!.state).not.toContain("Sup3rS3cret!");
  });
});

describe("secretValues / redact (spec §3.7)", () => {
  it("collects knowledge values under secret-looking keys, and secret env values", () => {
    const s = secretValues(
      "Admin login: admin@acme.test\npassword: Sup3rS3cret!\n- API key = `sk-live-abcdef`\nSpinner: shows loading\nOTP: 123456",
      { ANTHROPIC_API_KEY: "sk-ant-0123456789", PATH: "/usr/bin:/bin", SHORT_TOKEN: "abc", NODE_ENV: "production" },
    );
    expect(s).toContain("Sup3rS3cret!");
    expect(s).toContain("sk-live-abcdef");
    expect(s).toContain("123456");
    expect(s).toContain("sk-ant-0123456789");
    expect(s).not.toContain("shows"); // "Spinner" is not a "pin"
    expect(s).not.toContain("admin@acme.test"); // a login is not a secret
    expect(s).not.toContain("/usr/bin:/bin");
    expect(s).not.toContain("abc"); // too short to be a credential, too common to scrub
    expect(s).not.toContain("production");
  });

  it("redacts every occurrence, longest secret first", () => {
    expect(redact("a SECRET-LONG b SECRET c", secretValues("token: SECRET\npassword: SECRET-LONG", {}))).toBe(
      "a ‹redacted› b ‹redacted› c",
    );
    expect(redact("nothing here", [])).toBe("nothing here");
  });
});
