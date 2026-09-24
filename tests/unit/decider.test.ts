import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDecider, dataDestination, writeShadowFile, deciderReportKeys } from "../../src/decider/index.js";
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
  shadow: false,
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
    ["https://127.evil.com", false, "127.evil.com"], // a DNS name, not the loopback address
    ["http://127.0.0.2:8000", true, "this machine"],
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
    expect(d.caps.maxInputChars).toBe(1200);
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

  it("…and from every question's text; option labels (the answer contract) stay as they are", async () => {
    const fetchFn = respond({
      answers: { q: { type: "choice", choice: "c1", probabilities: { c1: 0.9, c2: 0.1 }, confidence: 0.9 } },
    });
    const traces: DecisionTrace[] = [];
    const d = makeDecider(cfg(), {
      ledger: new CostLedger(),
      fetchFn,
      secrets: ["Sup3rS3cret!"],
      telemetry: { recordDecision: (t) => void traces.push(t) },
    })!;
    const question: Question = {
      type: "choice",
      instructions: "Which element does the step 'type Sup3rS3cret! into Password' mean?",
      options: { c1: "textbox Password (holds Sup3rS3cret!)", c2: null },
    };
    const a = await d.decide("coverage", "S", { q: question });
    expect(a.q).toMatchObject({ value: "c1" });
    const sent = JSON.stringify((sentBody(fetchFn) as unknown as { questions: unknown }).questions);
    expect(sent).not.toContain("Sup3rS3cret!");
    expect(sent).toContain('"c1"');
    expect(JSON.stringify(traces[0]!.questions)).not.toContain("Sup3rS3cret!");
  });

  it("a scrubbing failure is a recorded fallback (DeciderUnavailable) — and its trace carries no raw text", async () => {
    const fetchFn = jevOk();
    const traces: DecisionTrace[] = [];
    const d = makeDecider(cfg(), {
      ledger: new CostLedger(),
      fetchFn,
      secrets: ["Sup3rS3cret!"],
      telemetry: { recordDecision: (t) => void traces.push(t) },
    })!;
    // A use-point bug: an option description that is not a string at runtime.
    const broken = { type: "choice", instructions: "pick", options: { c1: undefined, c2: null } } as unknown as Question;
    await expect(d.decide("coverage", "type Sup3rS3cret! into Password", { q: broken })).rejects.toBeInstanceOf(
      DeciderUnavailable,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(traces).toEqual([expect.objectContaining({ fallback: true, state: "", questions: {} })]);
  });

  it("a tracer that throws never turns an answer into a fallback, nor escapes as another error", async () => {
    const ledger = new CostLedger();
    const boom = (): void => {
      throw new Error("tracing is down");
    };
    const ok = makeDecider(cfg(), { ledger, fetchFn: jevOk(), telemetry: { recordDecision: boom } })!;
    await expect(ok.decide("coverage", "S", { q })).resolves.toMatchObject({ q: { value: true } });
    expect(ledger.report().perRole[0]!.calls).toBe(1);
    const dead = makeDecider(cfg(), { ledger, fetchFn: respond({}, 401), telemetry: { recordDecision: boom } })!;
    await expect(dead.decide("coverage", "S", { q })).rejects.toThrow("HTTP 401");
  });
});

describe("shadow mode (spec §7) and the run summary", () => {
  const layaFetch = () =>
    respond({
      model: "laya-rl-agent",
      answers: { q: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.5 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });

  it("a shadow decider meters into its own ledger — the run's cost report stays byte-identical", async () => {
    const ledger = new CostLedger();
    const d = makeDecider(cfg({ ...localLaya, shadow: true }), { ledger, fetchFn: layaFetch() })!;
    await d.decide("coverage", "S", { q });
    expect(ledger.report().perRole).toEqual([]);
    expect(d.shadow?.entries).toEqual([]);
  });

  it("an active decider has no shadow log", () => {
    expect(makeDecider(cfg(localLaya), { ledger: new CostLedger() })!.shadow).toBeUndefined();
  });

  it("summary() counts every decide() call and lists each fallback with its reason", async () => {
    const d = makeDecider(cfg(localLaya), { ledger: new CostLedger(), fetchFn: respond({}, 500) })!;
    await expect(d.decide("repair-triage", "S", { q })).rejects.toBeInstanceOf(DeciderUnavailable);
    await expect(d.decide("coverage", "x".repeat(1201), { q })).rejects.toBeInstanceOf(DeciderUnavailable);
    expect(d.summary()).toEqual({
      provider: "laya",
      model: "jev-latest",
      calls: 2,
      fallbacks: [
        { use: "repair-triage", reason: "HTTP 500" },
        { use: "coverage", reason: "input is 1212 chars (state 1201 + question 11) > 1200" },
      ],
    });
  });

  it("shadow.record keeps every entry and sends agreement to tracing as decider.<use>.agreement", () => {
    const recordScore = vi.fn();
    const d = makeDecider(cfg({ ...localLaya, shadow: true }), { ledger: new CostLedger(), telemetry: { recordScore } })!;
    d.shadow!.record({ use: "coverage", input: { items: 1, cases: 1 }, current: 0.5, decider: 0.5, latencyMs: 3, agreement: 1 });
    d.shadow!.record({ use: "repair-triage", input: "S", current: "repair", decider: { unavailable: "HTTP 500" }, latencyMs: 3 });
    expect(d.shadow!.entries).toHaveLength(2);
    expect(recordScore).toHaveBeenCalledTimes(1);
    expect(recordScore).toHaveBeenCalledWith("decider.coverage.agreement", 1);
  });

  it("shadow entries are scrubbed like a state — decider-shadow.json never holds a secret the run knows", () => {
    const d = makeDecider(cfg({ ...localLaya, shadow: true }), { ledger: new CostLedger(), secrets: ["Sup3rS3cret!"] })!;
    d.shadow!.record({
      use: "repair-triage",
      input: 'Playwright test "signs in" failed.\nError: fill("Sup3rS3cret!") timed out',
      current: "repair",
      decider: { category: "timing", confidence: 0.8, wouldExclude: false },
      latencyMs: 3,
    });
    d.shadow!.record({ use: "coverage", input: { items: ["type Sup3rS3cret! into Password"], cases: [] }, current: 1, decider: 1, latencyMs: 3 });
    expect(JSON.stringify(d.shadow!.entries)).not.toContain("Sup3rS3cret!");
    expect(d.shadow!.entries[0]).toMatchObject({ input: 'Playwright test "signs in" failed.\nError: fill("‹redacted›") timed out' });
    expect(d.shadow!.entries[1]).toMatchObject({ input: { items: ["type ‹redacted› into Password"] }, latencyMs: 3 });
  });

  it("deciderReportKeys: nothing without a decider or in shadow mode; the summary and not-repaired tests when active", () => {
    const tr = { test: "A", category: "app-bug" as const, confidence: 0.9, exclude: true };
    expect(deciderReportKeys(undefined)).toEqual({});
    expect(deciderReportKeys(undefined, [])).toEqual({});
    expect(deciderReportKeys(makeDecider(cfg({ ...localLaya, shadow: true }), { ledger: new CostLedger() }), [])).toEqual({});
    const active = makeDecider(cfg(localLaya), { ledger: new CostLedger() })!;
    expect(deciderReportKeys(active, [tr])).toEqual({
      decider: { provider: "laya", model: "jev-latest", calls: 0, fallbacks: [] },
      notRepaired: [tr],
    });
  });

  it("writeShadowFile writes nothing without a decider or for an active one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-shadow-"));
    await writeShadowFile(dir, undefined);
    await writeShadowFile(dir, makeDecider(cfg(localLaya), { ledger: new CostLedger() }));
    expect(await readdir(dir)).toEqual([]);
  });

  it("writeShadowFile writes decider-shadow.json: provider, model, threshold, calls, fallbacks, private cost, entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-shadow-"));
    const d = makeDecider(cfg({ ...localLaya, shadow: true }), { ledger: new CostLedger(), fetchFn: layaFetch() })!;
    await d.decide("coverage", "S", { q });
    d.shadow!.record({ use: "coverage", input: { items: 1, cases: 1 }, current: 1, decider: [{ item: "a", covered: true }], latencyMs: 5, agreement: 1 });
    await writeShadowFile(dir, d);
    const file = JSON.parse(await readFile(join(dir, "decider-shadow.json"), "utf8"));
    expect(file).toMatchObject({ provider: "laya", model: "jev-latest", minConfidence: 0.75, calls: 1, fallbacks: [] });
    expect(file.cost.perRole).toEqual([expect.objectContaining({ role: "decider", calls: 1, inputTokens: 10, costUsd: 0 })]);
    expect(file.entries).toEqual([expect.objectContaining({ use: "coverage", agreement: 1 })]);
    // automate writes under its own name: the run dir may already hold design's file
    await writeShadowFile(dir, d, "decider-shadow-automate.json");
    expect((await readdir(dir)).sort()).toEqual(["decider-shadow-automate.json", "decider-shadow.json"]);
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

  // Every line a review raised, and the shapes a QA knowledge file really has.
  it.each([
    ["Креденшели: admin@test / secret", "secret"],
    ["Пароль: Sup3rS3cret!", "Sup3rS3cret!"],
    ["**Password:** Sup3rS3cret!", "Sup3rS3cret!"],
    ["Passphrase: correct horse battery", "correct horse battery"],
    ["Passcode: 4711", "4711"],
    ["Passwords: a1b2c3d4", "a1b2c3d4"],
    ["Password: qwerty", "qwerty"],
    ["Password: Sup,3rS3cret!", "Sup,3rS3cret!"],
    ["Credentials: admin / Sup3rS3cret!", "Sup3rS3cret!"],
    ["Password: `Sup3rS3cret!` (the admin's)", "Sup3rS3cret!"],
    ["- Password (admin): Sup3rS3cret!", "Sup3rS3cret!"],
    ["Password: Sup3rS3cret! for every test user", "Sup3rS3cret!"],
    ["Password: Sup3rS3cret! - same on staging", "Sup3rS3cret!"],
    ["Password: Sup3rS3cret! # admin", "Sup3rS3cret!"],
    ["**Password:** Sup3rS3cret! for every test user", "Sup3rS3cret!"],
    ["- **Password:** Sup3rS3cret! - same on staging", "Sup3rS3cret!"],
    ["Password for the admin: Sup3rS3cret!", "Sup3rS3cret!"],
    ["Password on staging: Qwerty123!", "Qwerty123!"],
    ["Password in prod: Qwerty123!", "Qwerty123!"],
    ["Password used by all test users: Qwerty123!", "Qwerty123!"],
    ["Password - admin: Qwerty123!", "Qwerty123!"],
    ["Password is: Qwerty123!", "Qwerty123!"],
    ["User: qa@acme.test, Password: Qwerty123!", "Qwerty123!"],
    ["Login/password: admin/Adm1n!2024", "Adm1n!2024"],
    ["Stripe key: sk_test_4eC39HqLyjWD", "sk_test_4eC39HqLyjWD"],
    ["Key: abcd-1234", "abcd-1234"],
    ["License key: ABCD-EFGH-1234", "ABCD-EFGH-1234"],
    ["PIN: 4711, same for all", "4711"],
    ["Пароль адміністратора: Sup3rS3cret!", "Sup3rS3cret!"],
    ["Тестовий пароль: Sup3rS3cret!", "Sup3rS3cret!"],
    ["Тестовий пароль для всіх: Qwerty123!", "Qwerty123!"],
    ["Логін і пароль адміна: admin / Adm1n!2024", "Adm1n!2024"],
    ["Токен доступу: tok-123456", "tok-123456"],
    ["Пароль: «Qwerty123!»", "Qwerty123!"],
    ["Password: “Sup3rS3cret!”", "Sup3rS3cret!"],
    ["| Role | Email | Password |\n|---|---|---|\n| admin | admin@acme.test | Adm1n!2024 |", "Adm1n!2024"],
    ["| Role | Password |\n|---|---|\n| viewer | qwerty |", "qwerty"],
    ["| Field | Value |\n|---|---|\n| Password | qwerty |", "qwerty"],
    ["Log in as admin@acme.test (password: Adm1n!2024)", "Adm1n!2024"],
    ["Увійти як admin@acme.test (пароль: Adm1n!2024)", "Adm1n!2024"],
    ["Email / password: qa@acme.test / qwerty", "qwerty"],
    ["Login / password: admin / qwerty", "qwerty"],
    ["Логін і пароль: qa@acme.test / qwerty", "qwerty"],
    ["Passcode: 4711, same for all", "4711"],
    ["Test account: qa@acme.test / Qwerty123!", "Qwerty123!"],
    ["User: qa@acme.test, Password: qwerty", "qwerty"],
    ["User: qa@acme.test, password:Qwerty123!", "Qwerty123!"],
    ["Пароль — qwerty", "qwerty"],
    ["OTP code: 123456", "123456"],
    ["PIN code: 4711", "4711"],
    ["PIN-код: 4711", "4711"],
    ["Credentials: admin:Adm1n!2024", "Adm1n!2024"],
    ['Password: "correct horse battery"', "correct horse battery"],
    ['Password: "correct horse battery" — same on staging', "correct horse battery"],
    ["ПІН-код: 4711", "4711"],
    ["ПІН: 4711", "4711"],
    ["ПИН-код: 4711", "4711"],
    ["ПИН: 4711", "4711"],
    ["Password - qwerty", "qwerty"],
    ["Пароль - qwerty", "qwerty"],
    ["New password: qwerty", "qwerty"],
    ["Login: admin / Password: qwerty", "qwerty"],
    ["Логін: admin / Пароль: qwerty", "qwerty"],
    ["Email: qa@acme.test | Password: qwerty", "qwerty"],
    ["| Параметр | Значення |\n|---|---|\n| Пароль | qwerty |", "qwerty"],
    ["| | |\n|---|---|\n| Login | admin |\n| Password | qwerty |", "qwerty"],
    ["| Environment | Staging |\n|---|---|\n| Password | qwerty |", "qwerty"],
    ["| | Staging | Production |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Account | Admin |\n|---|---|\n| Password | qwerty |", "qwerty"],
    ["| Роль | Адміністратор |\n|---|---|\n| Пароль | qwerty |", "qwerty"],
    ["Admin - Password: qwerty", "qwerty"],
    ["Admin — Password: qwerty", "qwerty"],
    ["Staging - password: qwerty", "qwerty"],
    ["Адмін - Пароль: qwerty", "qwerty"],
    ["Reset PIN: 4711", "4711"],
    ["| Item | Value |\n|---|---|\n| The password for the staging admin account that the nightly regression run uses | qwerty |", "qwerty"],
    ["| Environment | Staging | Production |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Role | Admin | Viewer |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Середовище | Staging | Production |\n|---|---|---|\n| Пароль | qwerty | letmein |", "letmein"],
    ["| | Admin | Controller |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Account | Information |\n|---|---|\n| Login | admin |\n| Password | qwerty |", "qwerty"],
    ["| Field | Value |\n|---|---|\n| Login | admin |\n| Password | secret |", "secret"],
    ["| Field | Type | Value |\n|---|---|---|\n| Password | password | qwerty |", "qwerty"],
    ["| Field | Required | Value |\n|---|---|---|\n| Password | yes | qwerty |", "qwerty"],
    ["| Field | Label | Test data |\n|---|---|---|\n| Password | Password | qwerty |", "qwerty"],
    ["| Поле | Обов'язкове | Значення |\n|---|---|---|\n| Пароль | так | qwerty |", "qwerty"],
    ["| Field | ID | Value |\n|---|---|---|\n| Password | password-input | qwerty |", "qwerty"],
    ["| Name | Env | Value |\n|---|---|---|\n| DB password | staging | qwerty |", "qwerty"],
    ["| Field | Required | Staging |\n|---|---|---|\n| Password | yes | qwerty |", "qwerty"],
    ["| Field | Old | New |\n|---|---|---|\n| Password | | qwerty |", "qwerty"],
    ["| Parameter | Staging | Production |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Key | QA | **Prod** |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Параметр | Тест | Прод |\n|---|---|---|\n| Пароль | qwerty | letmein |", "letmein"],
    ["| | Maxim | Olena |\n|---|---|---|\n| Password | qwerty | letmein |", "qwerty"],
    ["| | Максим | Олена |\n|---|---|---|\n| Пароль | qwerty | letmein |", "qwerty"],
    ["| Field | Data source | Value |\n|---|---|---|\n| Password | vault | qwerty |", "qwerty"],
    ["| Field | Metadata | Value |\n|---|---|---|\n| Password | internal | qwerty |", "qwerty"],
    ["| Field | Default value | Test value |\n|---|---|---|\n| Password | none | qwerty |", "qwerty"],
    ["| Field | Invalid value | Valid value |\n|---|---|---|\n| Password | abcdef | qwerty |", "qwerty"],
    ["| Поле | Невалідне значення | Валідне значення |\n|---|---|---|\n| Пароль | abcdef | qwerty |", "qwerty"],
    ["| Поле | Значення за замовчуванням | Тестове значення |\n|---|---|---|\n| Пароль | немає | qwerty |", "qwerty"],
    ["| Поле | Метка | Значение |\n|---|---|---|\n| Пароль | Пароль | qwerty |", "qwerty"],
    ["| Field | Label | **Value** |\n|---|---|---|\n| Password | Password | qwerty |", "qwerty"],
    ["| Parameter | QA1 | QA2 |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Parameter | Staging EU | Prod (US) |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Parameter | stage-1 | stage-2 |\n|---|---|---|\n| Password | qwerty | letmein |", "letmein"],
    ["| Field | Required | Staging |\n|---|---|---|\n| Password | ✓ | qwerty |", "qwerty"],
    ["| Field | Required | Staging |\n|---|---|---|\n| Password | **yes** | qwerty |", "qwerty"],
    ["| Field | Mandatory | Staging |\n|---|---|---|\n| Password | required | qwerty |", "qwerty"],
    ["| Поле | Обов'язкове | Нове |\n|---|---|---|\n| Пароль | Так | qwerty |", "qwerty"],
  ])("knowledge %j yields a scrubbable secret", (line, secret) => {
    expect(redact(`type ${secret} into the field`, secretValues(line, {}))).toBe("type ‹redacted› into the field");
  });

  it.each([
    "Key pages: /checkout, /cart",
    "Pass criteria: every field is filled",
    "Password rules: must contain a digit",
    "Password: required, 8-64 characters",
    "Password: one-time, sent by e-mail",
    "OTP: 6-digit code sent by SMS",
    "OTP delivery: SMS, email",
    "Admin login (see the password manager): open /login",
    "Token lifetime: 3600 seconds",
    "Sort key: name",
    "Shortcut key: Enter",
    "Правила пароля: мінімум 8 символів",
    "Ключові сторінки: кошик, оформлення",
    "Password: none",
    "| Field | Value |\n|---|---|\n| Password | see the vault |\n| Role | admin |",
    'Login page: "Sign in" heading, "Forgot password?" link',
    "Форма входу: поле «Email», поле «Пароль», кнопка «Увійти».",
    'Wrong password shows "Invalid email or password".',
    "Forgot password? link opens the reset flow",
    "Password reset page: http://localhost:3000/forgot-password",
    "| Password | Expected |\n|---|---|",
    "Password: required",
    "Credentials: Bitwarden",
    "- Forgot password: /forgot-password",
    "- Change password: /settings/password",
    "- Password: /account/password",
    "API key: https://dashboard.stripe.com/apikeys",
    "Forgot password — broken",
    "Change password — Settings",
    "Змінити пароль — Налаштування",
    "| Field | Type | Required |\n|---|---|---|\n| Password | password | yes |",
    "| Field | Role |\n|---|---|\n| Password | textbox |",
    '- Password: required, min 8; error "Password must be at least 8 characters"',
    'Sort key: "name"',
    "Accounts: viewer@acme.test / editor@acme.test, password in the vault",
    "Support: qa@acme.test / +380-44-123-4567",
    "| Field | Data type |\n|---|---|\n| Password | password |",
    "| Field | Required | Type |\n|---|---|---|\n| Password | yes | password |",
    "| Field | Rule |\n|---|---|\n| Password | strong |",
    "| | |\n|---|---|\n| Password | textbox |",
    "## Passwords - staging",
    'Empty password: "Password is required"',
    'Wrong password: "Invalid email or password"',
    "Порожній пароль: «Пароль обов’язковий»",
    "Сменить пароль — Настройки",
    "| Field | Input | Expected | Actual |\n|---|---|---|---|\n| Password | 123 | error | error |",
    "| Key | en | de | fr |\n|---|---|---|---|\n| Password | Password | Passwort | Mot de passe |",
    "| Ключ | EN | PL |\n|---|---|---|\n| Пароль | Password | Hasło |",
    "| Feature | Status |\n|---|---|\n| Password | pass |",
    "| Field | Min | Max |\n|---|---|---|\n| PIN | 1000 | 9999 |",
    "| Field | Length |\n|---|---|\n| Password | 8-64 |",
    "| Field | Default value |\n|---|---|\n| Password | empty |",
    "| Check | Result |\n|---|---|\n| Password | passed |",
    "| Check | Actual |\n|---|---|\n| Password | accepted |",
    "| Поле | Мін | Макс |\n|---|---|---|\n| ПІН | 1000 | 9999 |",
    "| Перевірка | Статус |\n|---|---|\n| Пароль | пройдено |",
    "Пароль: порожній",
    "Password: password",
    "Password: text",
    "| Поле | Мінімальне значення | Максимальне значення |\n|---|---|---|\n| ПІН | 1000 | 9999 |",
    "| Поле | Минимальное значение |\n|---|---|\n| ПИН | 1000 |",
    "Пароль: немає",
  ])("knowledge %j holds no secret — nothing of it is scrubbed", (line) => {
    expect(secretValues(line, {})).toEqual([]);
  });

  // Outside a matrix a key–value row has one value column; the ones after it are results, not secrets.
  it.each([
    ["| Field | Valid | Invalid | Result |\n|---|---|---|---|\n| Password | Qwerty123! | abc | Invalid |", "Invalid"],
    ["| Field | Test case | Result |\n|---|---|---|\n| Password | TC-012 | fail |", "fail"],
    ["| Field | Chrome | Firefox | Safari |\n|---|---|---|---|\n| Password | works | works | broken |", "broken"],
    ["| Field | ID | Value |\n|---|---|---|\n| Password | password-input | qwerty |", "password-input"],
    ["| Name | Env | Value |\n|---|---|---|\n| DB password | staging | qwerty |", "staging"],
    ["| Field | Data source | Value |\n|---|---|---|\n| Password | vault | qwerty |", "vault"],
    ["| Field | Invalid value | Valid value |\n|---|---|---|\n| Password | abcdef | qwerty |", "abcdef"],
  ])("knowledge %j: %s is not a secret", (line, word) => {
    expect(secretValues(line, {})).not.toContain(word);
  });

  it("a password env variable that names a type is not scrubbed: `password` protects nothing", () => {
    expect(secretValues("", { DB_PASSWORD: "password", E2E_PASSWORD: "Passw0rd" })).toEqual(["Passw0rd"]);
  });

  it("a password with a space or prose after it: no fragment of it survives, and no plain word is taken", () => {
    const s = secretValues("Password: Sup3r S3cret!\nPassword: from env E2E_PASSWORD", {});
    expect(redact("type Sup3r S3cret! into the field", s)).not.toMatch(/Sup3r|S3cret/);
    expect(s).not.toContain("from");
    expect(redact("the value from the form", s)).toBe("the value from the form");
  });

  it("a plain secret or a PIN is replaced as a whole token — never inside a longer word", () => {
    expect(redact("Username: name; name-tag; the name", ["name"])).toBe("Username: ‹redacted›; ‹redacted›-tag; the ‹redacted›");
    expect(redact("qwertyuiop, qwerty", ["qwerty"])).toBe("qwertyuiop, ‹redacted›");
    expect(redact("order 14711, PIN 4711", ["4711"])).toBe("order 14711, PIN ‹redacted›");
  });

  it("a credential-shaped secret is replaced wherever it appears — a value derived from it carries it", () => {
    const s = secretValues("Password: Qwerty123!", {});
    expect(redact("negative case: type Qwerty123!x, then xQwerty123!", s)).toBe("negative case: type ‹redacted›x, then x‹redacted›");
    expect(redact("fill('Sup3rS3cret!') and Sup3rS3cret!!", ["Sup3rS3cret!"])).toBe("fill('‹redacted›') and ‹redacted›!");
  });

  it("env: short secrets count, the working directory and flags do not", () => {
    const s = secretValues("", {
      TEST_USER_PASSWORD: "Test123",
      DB_PASS: "hunter2x",
      DB_PASSWORD: "postgres",
      PWD: "/home/qa/project",
      OLDPWD: "/home/qa",
      PASS_THROUGH: "enabled",
      ENABLE_TOKEN: "true",
      TOKEN_TTL: "3600",
      LANGFUSE_PUBLIC_KEY: "pk-lf-123456",
      STRIPE_PUBLISHABLE_KEY: "pk_test_123456",
      KEYBOARD_LAYOUT: "dvorak-uk",
      VITE_STORAGE_KEY: "user",
      PASSWORD_POLICY: "strict",
    });
    expect(s).toEqual(expect.arrayContaining(["Test123", "hunter2x", "postgres"]));
    for (const v of ["/home/qa/project", "/home/qa", "enabled", "true", "3600", "pk-lf-123456", "pk_test_123456", "dvorak-uk", "user", "strict"]) {
      expect(s).not.toContain(v);
    }
  });

  it("env: any *_KEY and any name carrying SECRET or PASSWORD, when the value looks like a credential", () => {
    const env = {
      STRIPE_KEY: "sk_live_111111",
      APP_KEY: "base64:222222",
      ENCRYPTION_KEY: "enc-333333",
      SERVICE_ROLE_KEY: "srk-444444",
      OPENAI_KEY: "sk-555555",
      SECRET_KEY_BASE: "skb-666666",
      PASSWORD_HASH_PEPPER: "pepper-777777",
      API_TOKEN: "Welcome!", // an env value is not prose: its closing "!" is part of it
      ADMIN_SECRET: "Secret!",
      JWT_SECRET: "letmein?",
    };
    expect(secretValues("", env).sort()).toEqual(Object.values(env).sort());
  });

  it("a long line costs linear time — no pattern rescans a run of word characters from every position", () => {
    const time = (text: string): number => {
      const t0 = performance.now();
      secretValues(text, {});
      return performance.now() - t0;
    };
    time("warm-up password: Qwerty123!");
    expect(time("a".repeat(80_000))).toBeLessThan(500); // quadratic, this took seconds
    expect(time(`password: ${"a b, ".repeat(20_000)}`)).toBeLessThan(500);
    expect(time(`password ${"_".repeat(80_000)}x`)).toBeLessThan(500); // a trailing-punctuation strip
    expect(time(`password ${"?".repeat(80_000)}x`)).toBeLessThan(500); // a closing "?!" trim
    expect(time(`Password: a${" ".repeat(80_000)}b`)).toBeLessThan(500);
    expect(time(`Password: ${"(".repeat(80_000)}`)).toBeLessThan(500);
    expect(time(`| ${"key ".repeat(20_000)}| x |\n|---|---|\n| ${"password ".repeat(10_000)}| qwerty |`)).toBeLessThan(500);
    // the header's environment names and bounds: a letter run that ends in a non-letter
    expect(time(`| Field | ${"стейдж".repeat(13_000)}1 | ${"мінімальн".repeat(9_000)}x |\n|---|---|---|\n| Password | a | b |`)).toBeLessThan(500);
    // a value word at every word start, and an environment name trailed by a long run that fails its suffix
    expect(time(`| Field | ${"value ".repeat(13_000)}x | prod${" ".repeat(80_000)}! |\n|---|---|---|\n| Password | a | b |`)).toBeLessThan(500);
  });

  it("redacts every occurrence, longest secret first", () => {
    expect(redact("a abc-123-long b abc-123 c", secretValues("token: abc-123\npassword: abc-123-long", {}))).toBe(
      "a ‹redacted› b ‹redacted› c",
    );
    expect(redact("nothing here", [])).toBe("nothing here");
  });
});
