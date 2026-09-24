import { describe, it, expect, vi } from "vitest";
import { postSystemOne, noulConfidence, type HttpTarget } from "../../src/decider/client-http.js";
import { guarded } from "../../src/decider/guarded.js";
import { DeciderUnavailable, type Question } from "../../src/decider/types.js";

const jev: HttpTarget = { provider: "jev", baseUrl: "https://api.typesafe.ai/", model: "jev-latest", apiKey: "k-jev" };
const laya: HttpTarget = { provider: "laya", baseUrl: "http://127.0.0.1:8000", model: "jev-latest" };
const signal = new AbortController().signal;

/** A fetch that records each request and answers with `body` (status 200 unless given). */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const header = (init: RequestInit, name: string): string | undefined => (init.headers as Record<string, string>)[name];

const noul: Question = { type: "noul", instructions: "Destructive?", criteria: { true: "Cannot be undone", false: "Harmless" } };
const choice: Question = {
  type: "choice",
  instructions: "Why?",
  options: { "locator-missing": "no element", timing: "too slow" },
};
const score: Question = { type: "score", instructions: "Relevant?", levels: ["no", "somewhat", "yes"] };

describe("postSystemOne — request (Jev wire format, typesafe_sdk 0.7.1 + docs.typesafe.ai/api)", () => {
  it("POSTs criteria as a map for choice, an ordered list for score, true/false for noul", async () => {
    const f = fakeFetch({
      model: "jev-1.13.0",
      answers: {
        n: { type: "noul", noul: 0.9 },
        c: { type: "choice", choice: "timing", probabilities: { "locator-missing": 0.2, timing: 0.8 }, confidence: 0.6 },
        s: {
          type: "score",
          score: 1.7,
          legend: { "0": "no", "1": "somewhat", "2": "yes" },
          probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
          confidence: 0.7,
        },
      },
      usage: { input_tokens: 120, output_tokens: 9 },
    });
    await postSystemOne(jev, "S", { n: noul, c: choice, s: score }, signal, f.fn);
    expect(f.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(header(f.calls[0]!.init, "authorization")).toBe("Bearer k-jev");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      state: "S",
      model: "jev-latest",
      questions: {
        n: { type: "noul", instructions: "Destructive?", criteria: { true: "Cannot be undone", false: "Harmless" } },
        c: { type: "choice", instructions: "Why?", criteria: { "locator-missing": "no element", timing: "too slow" } },
        s: { type: "score", instructions: "Relevant?", criteria: ["no", "somewhat", "yes"] },
      },
    });
  });

  it("no key → no authorization header", async () => {
    const f = fakeFetch({ answers: { n: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.5 } } });
    await postSystemOne(laya, "S", { n: noul }, signal, f.fn);
    expect(header(f.calls[0]!.init, "authorization")).toBeUndefined();
  });

  it("laya: a noul goes over the wire as choice {a: criteria.true, b: criteria.false}", async () => {
    const f = fakeFetch({ answers: { n: { type: "choice", choice: "a", probabilities: { a: 0.94, b: 0.06 }, confidence: 0.67 } } });
    const r = await postSystemOne(laya, "S", { n: noul }, signal, f.fn);
    expect(JSON.parse(String(f.calls[0]!.init.body)).questions.n).toEqual({
      type: "choice",
      instructions: "Destructive?",
      criteria: { a: "Cannot be undone", b: "Harmless" },
    });
    expect(r.answers.n).toEqual({ type: "noul", value: true, p: 0.94, confidence: noulConfidence(0.94) });
  });

  it("compat speaks plain Jev: a noul stays a noul", async () => {
    const compat: HttpTarget = { provider: "compat", baseUrl: "http://x.test", model: "m" };
    const f = fakeFetch({ answers: { n: { type: "noul", noul: 0.1 } } });
    const r = await postSystemOne(compat, "S", { n: noul }, signal, f.fn);
    expect(JSON.parse(String(f.calls[0]!.init.body)).questions.n.type).toBe("noul");
    expect(r.answers.n).toMatchObject({ type: "noul", value: false, p: 0.1 });
  });
});

describe("postSystemOne — response mapping", () => {
  it("maps the three answer types, usage and the answering model", async () => {
    const f = fakeFetch({
      model: "jev-1.13.0",
      answers: {
        n: { type: "noul", noul: 0.2 },
        c: { type: "choice", choice: "timing", probabilities: { "locator-missing": 0.2, timing: 0.8 }, confidence: 0.6 },
        s: { type: "score", score: 1.7, legend: {}, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 }, confidence: 0.7 },
      },
      usage: { input_tokens: 120, output_tokens: 9 },
    });
    const r = await postSystemOne(jev, "S", { n: noul, c: choice, s: score }, signal, f.fn);
    expect(r.answers.n).toEqual({ type: "noul", value: false, p: 0.2, confidence: noulConfidence(0.2) });
    expect(r.answers.c).toEqual({
      type: "choice",
      value: "timing",
      dist: { "locator-missing": 0.2, timing: 0.8 },
      confidence: 0.6,
    });
    expect(r.answers.s).toEqual({ type: "score", value: 1.7, dist: [0.1, 0.1, 0.8], confidence: 0.7 });
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 9 });
    expect(r.model).toBe("jev-1.13.0");
  });

  it("no usage reported → no usage in the result (the caller estimates)", async () => {
    const r = await postSystemOne(jev, "S", { n: noul }, signal, fakeFetch({ answers: { n: { type: "noul", noul: 0.9 } } }).fn);
    expect(r.usage).toBeUndefined();
    expect(r.model).toBeUndefined();
  });

  it("noul confidence is |2p − 1|: 0 at a coin flip, 1 at certainty", () => {
    expect(noulConfidence(0.5)).toBe(0);
    expect(noulConfidence(1)).toBe(1);
    expect(noulConfidence(0)).toBe(1);
    expect(noulConfidence(0.875)).toBeCloseTo(0.75);
  });

  it.each([
    [
      "a choice outside the offered options",
      { c: { type: "choice", choice: "app-bug", probabilities: { "app-bug": 1 }, confidence: 1 } },
      { c: choice },
    ],
    ["a missing answer", {}, { c: choice }],
    ["a type that does not match the question", { c: { type: "noul", noul: 0.9 } }, { c: choice }],
    ["a probability outside 0..1", { n: { type: "noul", noul: 1.5 } }, { n: noul }],
    ["a score outside the levels", { s: { type: "score", score: 7, probabilities: {}, confidence: 0.9 } }, { s: score }],
    [
      "laya's two-option form without option 'a'",
      { n: { type: "choice", choice: "b", probabilities: { b: 1 }, confidence: 1 } },
      { n: noul },
    ],
    [
      "laya's two-option form choosing a label it was never offered",
      { n: { type: "choice", choice: "zzz", probabilities: { a: 0.9 }, confidence: 0.8 } },
      { n: noul },
    ],
    [
      "laya's two-option form picking 'b' while p(a) = 0.9",
      { n: { type: "choice", choice: "b", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 } },
      { n: noul },
    ],
  ])("rejects %s → DeciderUnavailable (an untrusted answer is never acted on)", async (_label, answers, qs) => {
    const target = "n" in qs && _label.startsWith("laya") ? laya : jev;
    await expect(
      postSystemOne(target, "S", qs as Record<string, Question>, signal, fakeFetch({ answers }).fn),
    ).rejects.toBeInstanceOf(DeciderUnavailable);
  });

  it("HTTP error → DeciderUnavailable carrying the status; a body that is not JSON → unavailable", async () => {
    const e = await postSystemOne(jev, "S", { n: noul }, signal, fakeFetch({ detail: "x" }, 503).fn).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeciderUnavailable);
    expect((e as DeciderUnavailable).status).toBe(503);
    const html = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(postSystemOne(jev, "S", { n: noul }, signal, html)).rejects.toBeInstanceOf(DeciderUnavailable);
    await expect(postSystemOne(jev, "S", { n: noul }, signal, fakeFetch([1, 2]).fn)).rejects.toBeInstanceOf(
      DeciderUnavailable,
    );
  });

  it("network failure → DeciderUnavailable without a status (never retried)", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const e = await postSystemOne(jev, "S", { n: noul }, signal, down).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeciderUnavailable);
    expect((e as DeciderUnavailable).status).toBeUndefined();
  });

  it("never puts the API key into an error message", async () => {
    const e = await postSystemOne(jev, "S", { n: noul }, signal, fakeFetch({}, 401).fn).catch((x: unknown) => x as Error);
    expect((e as Error).message).not.toContain("k-jev");
  });

  it("a fetch error is reported by its name and cause code, never its message (which can quote a key or a URL)", async () => {
    const leaky = vi.fn(async () => {
      throw new TypeError('Headers.append: "Bearer k-jev\r\n" is an invalid header value.');
    }) as unknown as typeof fetch;
    const e1 = (await postSystemOne(jev, "S", { n: noul }, signal, leaky).catch((x: unknown) => x)) as Error;
    expect(e1.message).toBe("request failed: TypeError");
    const refused = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const e2 = (await postSystemOne(jev, "S", { n: noul }, signal, refused).catch((x: unknown) => x)) as Error;
    expect(e2.message).toBe("request failed: TypeError (ECONNREFUSED)");
  });
});

describe("guarded — bounds on every decider call", () => {
  it("retries exactly once on 429/5xx, then gives up", async () => {
    const g = guarded({ timeoutMs: 1000, maxCalls: 5, retryDelayMs: 0 });
    const attempt = vi.fn(async () => {
      throw new DeciderUnavailable("HTTP 503", 503);
    });
    await expect(g.run(attempt)).rejects.toBeInstanceOf(DeciderUnavailable);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("a 429 then success → the answer", async () => {
    const g = guarded({ timeoutMs: 1000, maxCalls: 5, retryDelayMs: 0 });
    let n = 0;
    await expect(
      g.run(async () => {
        if (n++ === 0) throw new DeciderUnavailable("HTTP 429", 429);
        return "ok";
      }),
    ).resolves.toBe("ok");
  });

  it("4xx other than 429, and network errors, are not retried", async () => {
    const g = guarded({ timeoutMs: 1000, maxCalls: 5, retryDelayMs: 0 });
    const a422 = vi.fn(async () => {
      throw new DeciderUnavailable("HTTP 422", 422);
    });
    const aNet = vi.fn(async () => {
      throw new DeciderUnavailable("request failed");
    });
    await expect(g.run(a422)).rejects.toThrow();
    await expect(g.run(aNet)).rejects.toThrow();
    expect(a422).toHaveBeenCalledTimes(1);
    expect(aNet).toHaveBeenCalledTimes(1);
  });

  it("timeout → DeciderUnavailable, and the in-flight request is aborted", async () => {
    const g = guarded({ timeoutMs: 20, maxCalls: 5 });
    let aborted = false;
    const slow = (s: AbortSignal): Promise<string> =>
      new Promise<string>((_, reject) => {
        s.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    await expect(g.run(slow)).rejects.toThrow(/timeout after 20 ms/);
    expect(aborted).toBe(true);
  });

  it("a request that rejects AFTER the timeout does not surface as an unhandled rejection", async () => {
    const g = guarded({ timeoutMs: 10, maxCalls: 5 });
    const late = (): Promise<string> => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late")), 40));
    await expect(g.run(late)).rejects.toThrow(/timeout/);
    await new Promise((r) => setTimeout(r, 60)); // vitest fails the run on an unhandled rejection
  });

  it("the per-run ceiling refuses without calling the server", async () => {
    const g = guarded({ timeoutMs: 1000, maxCalls: 2 });
    const attempt = vi.fn(async () => "ok");
    await g.run(attempt);
    await g.run(attempt);
    await expect(g.run(attempt)).rejects.toThrow(/ceiling/);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(g.calls).toBe(2);
  });
});
