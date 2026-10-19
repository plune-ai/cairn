import { describe, it, expect, vi, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runApiCases, type FetchLike, type ResponseLike } from "../../src/api/runner.js";
import { runApiScenarios } from "../../src/api/scenario-runner.js";
import { generateApiCases, type ApiCase } from "../../src/api/cases.js";
import { ingestOpenApi } from "../../src/api/openapi.js";
import {
  RequestGuard,
  collectSecrets,
  maskSecrets,
  parseBaseUrl,
  parsePositiveInt,
  parsePositiveNumber,
  tooShortSecrets,
  MIN_RPS,
} from "../../src/api/guard.js";
import { computeApiCoverage } from "../../src/api/coverage.js";

/**
 * #196: request guardrails for `cairn api --base-url` — mutations off by default, method/path
 * allow-lists, a request budget that counts retries, a run-wide rate limit, a pinned host with no
 * followed redirects, dot-segment protection in path params, and secret masking. The network is a
 * stub `fetch`, never real; the rate limit runs on fake timers.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");
const BASE = "https://api.test/v1";

function res(status: number, body: unknown = "", headers: Record<string, string> = {}): ResponseLike {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: async () => text };
}

function stub(respond: (url: string, init: RequestInit) => ResponseLike | Promise<ResponseLike>): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

function caseOf(over: Partial<ApiCase> = {}): ApiCase {
  return {
    name: "getPet",
    method: "GET",
    path: "/pets/{id}",
    params: { path: { id: "7" }, query: {}, header: {}, cookie: {} },
    expectedStatus: "200",
    type: "Positive",
    technique: "equivalence-partitioning",
    rationale: "test",
    ...over,
  } as ApiCase;
}

const methodCases = (): ApiCase[] =>
  ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((method) =>
    caseOf({ name: `${method} /things`, method, path: "/things", params: { path: {}, query: {}, header: {}, cookie: {} } }),
  );

/** A guard that never sleeps — the policy tests are not about timing. */
const fastGuard = (o: ConstructorParameters<typeof RequestGuard>[0] = {}): RequestGuard =>
  new RequestGuard({ rps: 1_000_000, ...o });

afterEach(() => vi.useRealTimers());

describe("mutations are off by default", () => {
  it("sends no POST/PUT/PATCH/DELETE and reports them as skipped: mutations disabled, with the count", async () => {
    const { fetch, calls } = stub(() => res(200));
    const guard = fastGuard();
    const results = await runApiCases(methodCases(), { baseUrl: BASE, fetch, guard });

    expect(calls.map((c) => c.init.method)).toEqual(["GET", "HEAD", "OPTIONS"]);
    const skipped = results.filter((r) => r.skipped === "mutations disabled");
    expect(skipped.map((r) => r.method)).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
    expect(skipped.every((r) => r.attempts === 0 && !r.passed)).toBe(true);
    expect(guard.report().skipped).toEqual({ "mutations disabled": 4 });
    expect(guard.report().executed).toBe(3);
  });

  it("--allow-mutations runs the same cases", async () => {
    const { fetch, calls } = stub(() => res(200));
    const results = await runApiCases(methodCases(), { baseUrl: BASE, fetch, guard: fastGuard({ allowMutations: true }) });
    expect(calls).toHaveLength(7);
    expect(results.some((r) => r.skipped)).toBe(false);
  });

  it("psycho and hacker cases need --allow-mutations, even on a GET", async () => {
    const cases = [
      caseOf({ name: "psycho-post", method: "POST", adversarialStyle: "psycho" }),
      caseOf({ name: "hacker-get", method: "GET", adversarialStyle: "hacker", stripAuth: true }),
      caseOf({ name: "curious-get", method: "GET", adversarialStyle: "curious" }),
    ];
    const off = stub(() => res(200));
    const offResults = await runApiCases(cases, { baseUrl: BASE, fetch: off.fetch, guard: fastGuard() });
    expect(off.calls).toHaveLength(1); // only the curious GET
    expect(offResults.filter((r) => r.skipped).map((r) => r.name)).toEqual(["psycho-post", "hacker-get"]);

    const on = stub(() => res(200));
    await runApiCases(cases, { baseUrl: BASE, fetch: on.fetch, guard: fastGuard({ allowMutations: true }) });
    expect(on.calls).toHaveLength(3);
  });

  it("a scenario whose create step is skipped is skipped as a whole, not failed", async () => {
    const steps = [
      caseOf({ name: "create", method: "POST", path: "/things", params: { path: {}, query: {}, header: {}, cookie: {} } }),
      caseOf({ name: "read", method: "GET", path: "/things", params: { path: {}, query: {}, header: {}, cookie: {} } }),
    ];
    const { fetch, calls } = stub(() => res(200));
    const [r] = await runApiScenarios([{ name: "chain", steps, technique: "equivalence-partitioning", rationale: "" } as never], {
      baseUrl: BASE,
      fetch,
      guard: fastGuard(),
    });
    expect(calls).toHaveLength(0);
    expect(r!.passed).toBe(false);
    expect(r!.skipped).toBe(true);
    expect(r!.steps.map((s) => s.skipped)).toEqual(["mutations disabled", "mutations disabled"]);
  });
});

describe("allowed methods and paths", () => {
  it("skips everything outside the lists with the reason not allowed", async () => {
    const cases = [
      caseOf({ name: "a", path: "/pets" }),
      caseOf({ name: "b", path: "/pets/{id}" }),
      caseOf({ name: "c", path: "/admin/users" }),
      caseOf({ name: "d", method: "HEAD", path: "/pets" }),
    ];
    const { fetch, calls } = stub(() => res(200));
    const guard = fastGuard({ allowedMethods: ["get"], allowedPaths: ["/pets", "/pets/*"] });
    const results = await runApiCases(cases, { baseUrl: BASE, fetch, guard });

    expect(calls).toHaveLength(2);
    expect(results.map((r) => r.skipped)).toEqual([undefined, undefined, "not allowed", "not allowed"]);
    expect(guard.report().skipped).toEqual({ "not allowed": 2 });
  });

  it("* stays inside one path segment, ** crosses segments", async () => {
    const g = fastGuard({ allowedPaths: ["/a/*", "/deep/**"] });
    const p = (path: string) => g.check(caseOf({ path }));
    expect(p("/a/x")).toBeUndefined();
    expect(p("/a/x/y")).toBe("not allowed");
    expect(p("/deep/x/y")).toBeUndefined();
  });
});

describe("request budget", () => {
  it("stops at exactly --max-requests sends, retries included, and skips the rest", async () => {
    const { fetch, calls } = stub(() => res(503));
    const guard = fastGuard({ maxRequests: 10 });
    const cases = Array.from({ length: 6 }, (_, i) => caseOf({ name: `c${i}` }));
    const results = await runApiCases(cases, { baseUrl: BASE, fetch, guard, baseDelayMs: 0 });

    expect(calls).toHaveLength(10); // 3 + 3 + 3 + 1
    expect(results.map((r) => r.attempts)).toEqual([3, 3, 3, 1, 0, 0]);
    expect(results.slice(4).every((r) => r.skipped === "budget exhausted")).toBe(true);
    expect(guard.report()).toMatchObject({ requestsUsed: 10, maxRequests: 10, budgetExhausted: true });
  });

  it("a budget that is not reached is not reported as exhausted", async () => {
    const { fetch } = stub(() => res(200));
    const guard = fastGuard({ maxRequests: 10 });
    await runApiCases([caseOf()], { baseUrl: BASE, fetch, guard });
    expect(guard.report().budgetExhausted).toBe(false);
  });

  it("rejects bad numbers with a message that names the flag", () => {
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => parsePositiveInt("--max-requests", bad)).toThrow(/--max-requests must be a whole number/);
    }
    for (const bad of ["0", "-2", "abc", ""]) {
      expect(() => parsePositiveNumber("--rps", bad)).toThrow(/--rps must be a number greater than 0/);
    }
    expect(parsePositiveNumber("--rps", "0.5")).toBe(0.5);
  });
});

describe("rate limit (fake timers)", () => {
  it("--rps 5 never sends more than 5 requests in any second, even with parallel runs", async () => {
    vi.useFakeTimers();
    const sentAt: number[] = [];
    const { fetch } = stub(() => {
      sentAt.push(performance.now());
      return res(200);
    });
    const guard = new RequestGuard({ rps: 5, maxRequests: 1000 });
    const batch = () => runApiCases(Array.from({ length: 6 }, (_, i) => caseOf({ name: `c${i}` })), { baseUrl: BASE, fetch, guard });
    const done = Promise.all([batch(), batch(), batch()]); // three parallel runners, 18 requests
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(sentAt).toHaveLength(18);
    sentAt.sort((a, b) => a - b);
    for (let i = 0; i + 5 < sentAt.length; i++) {
      expect(sentAt[i + 5]! - sentAt[i]!).toBeGreaterThanOrEqual(1000); // 6 requests never fit in one second
    }
  });

  it("the first request is not delayed", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = stub(() => res(200));
    const p = runApiCases([caseOf()], { baseUrl: BASE, fetch, guard: new RequestGuard({ rps: 1 }) });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(calls).toHaveLength(1);
  });
});

describe("host pinning and redirects", () => {
  it("ignores `servers` on another host: every request goes to --base-url", async () => {
    const model = await ingestOpenApi(join(fixtures, "servers-other-host.yaml"));
    const { fetch, calls } = stub(() => res(200, "[]"));
    await runApiCases(generateApiCases(model), { baseUrl: BASE, fetch, guard: fastGuard({ allowMutations: true }) });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url.startsWith("https://api.test/v1/"))).toBe(true);
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("does not follow a redirect: it asks fetch not to, and records the 301/302", async () => {
    const { fetch, calls } = stub(() => res(302, "", { location: "https://other.example/login" }));
    const guard = fastGuard();
    const [r] = await runApiCases([caseOf()], { baseUrl: BASE, fetch, guard });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(r!.redirect).toEqual({ status: 302, location: "https://other.example/login" });
    expect(guard.report().redirects).toEqual([{ name: "getPet", status: 302, location: "https://other.example/login" }]);
  });
});

describe("path parameter protection", () => {
  it.each(["../admin", "%2e%2e/admin", "..%2Fadmin", "%252e%252e", "..", ".", "a/../../b", "..\\admin"])(
    "refuses a %j value that would climb out of the base path",
    async (id) => {
      const { fetch, calls } = stub(() => res(200));
      const guard = fastGuard();
      const [r] = await runApiCases([caseOf({ params: { path: { id }, query: {}, header: {}, cookie: {} } })], {
        baseUrl: BASE,
        fetch,
        guard,
      });
      expect(calls).toHaveLength(0);
      expect(r!.blocked).toMatch(/dot-segment/);
      expect(guard.report().blocked).toHaveLength(1);
    },
  );

  it.each(["//evil.example/x", "' OR '1'='1", "<script>alert(1)</script>", "a b", "1.5"])(
    "still sends %j: payloads stay legal inside a value and the URL stays under the base path",
    async (id) => {
      const { fetch, calls } = stub(() => res(200));
      await runApiCases([caseOf({ params: { path: { id }, query: {}, header: {}, cookie: {} } })], { baseUrl: BASE, fetch, guard: fastGuard() });
      expect(calls).toHaveLength(1);
      const u = new URL(calls[0]!.url);
      expect(u.origin).toBe("https://api.test");
      expect(u.pathname.startsWith("/v1/pets/")).toBe(true);
    },
  );
});

describe("secret masking", () => {
  it("collects sensitive header values and the credential of `Scheme credential`", () => {
    const found = collectSecrets({ Authorization: "Bearer TOPSECRET123", "X-Plain": "visible", "X-Api-Key": "k-12345" });
    expect(found).toEqual(expect.arrayContaining(["Bearer TOPSECRET123", "TOPSECRET123", "k-12345"]));
    expect(found).not.toContain("visible");
  });

  it("masks a secret echoed in the response body, in text and in the parsed json, and in errors", async () => {
    const headers = { Authorization: "Bearer TOPSECRET123" };
    const secrets = collectSecrets(headers);
    const { fetch } = stub(() => res(200, { echo: "Bearer TOPSECRET123", nested: { t: "TOPSECRET123" } }));
    const [r] = await runApiCases([caseOf()], { baseUrl: BASE, fetch, guard: fastGuard(), auth: { headers }, secrets });

    const dump = JSON.stringify(r);
    expect(dump).not.toContain("TOPSECRET123");
    expect(r!.response!.bodyText).toContain("***");
    expect(r!.request.headers["Authorization"]).toBe("***");
    expect(r!.passed).toBe(true); // masking changes what is recorded, not what is asserted
  });

  it("maskSecrets also hides the JSON-escaped form", () => {
    expect(maskSecrets('{"k":"a\\"b-secret"}', ['a"b-secret'])).toBe('{"k":"***"}');
  });
});

describe("fail closed (review)", () => {
  it("only GET/HEAD/OPTIONS run without --allow-mutations: TRACE, PURGE, custom verbs and lower-case post are mutating", async () => {
    const cases = ["TRACE", "PURGE", "LINK", "post", "Delete", "get"].map((method) => caseOf({ name: method, method }));
    const { fetch, calls } = stub(() => res(200));
    const results = await runApiCases(cases, { baseUrl: BASE, fetch, guard: fastGuard() });
    expect(calls.map((c) => c.init.method)).toEqual(["get"]);
    expect(results.filter((r) => r.skipped === "mutations disabled").map((r) => r.name)).toEqual(["TRACE", "PURGE", "LINK", "post", "Delete"]);
  });

  it("strips method-override headers and ?_method from a read-only run, whatever supplied them", async () => {
    const { fetch, calls } = stub(() => res(200));
    const guard = fastGuard();
    const c = caseOf({
      params: {
        path: { id: "7" },
        query: { _method: "DELETE", keep: "1" },
        header: { "X-HTTP-Method": "DELETE", "x-keep": "1" },
        cookie: {},
      },
    });
    await runApiCases([c], {
      baseUrl: BASE,
      fetch,
      guard,
      auth: { headers: { "X-HTTP-Method-Override": "DELETE", "X-Method-Override": "PUT", Authorization: "Bearer abcd1234" } },
    });
    const sent = calls[0]!.init.headers as Record<string, string>;
    expect(Object.keys(sent).filter((k) => /method/i.test(k))).toEqual([]);
    expect(sent["x-keep"]).toBe("1");
    expect(calls[0]!.url).toBe(`${BASE}/pets/7?keep=1`);
    expect(guard.report().overridesStripped).toBe(4);
  });

  it("leaves override headers alone once mutations are allowed", async () => {
    const { fetch, calls } = stub(() => res(200));
    await runApiCases([caseOf()], {
      baseUrl: BASE,
      fetch,
      guard: fastGuard({ allowMutations: true }),
      auth: { headers: { "X-HTTP-Method-Override": "PATCH" } },
    });
    expect((calls[0]!.init.headers as Record<string, string>)["X-HTTP-Method-Override"]).toBe("PATCH");
  });
});

describe("path guard (review)", () => {
  const sendId = async (id: string) => {
    const { fetch, calls } = stub(() => res(200));
    const [r] = await runApiCases([caseOf({ params: { path: { id }, query: {}, header: {}, cookie: {} } })], {
      baseUrl: BASE,
      fetch,
      guard: fastGuard(),
    });
    return { calls, r: r! };
  };

  it("decodes until stable: a value encoded five times is still seen as ..", async () => {
    let v = "..";
    for (let i = 0; i < 5; i++) v = encodeURIComponent(v);
    const { calls, r } = await sendId(v);
    expect(calls).toHaveLength(0);
    expect(r.blocked).toMatch(/dot-segment/);
  });

  it("an endless encoding is treated as hostile", async () => {
    let v = "..";
    for (let i = 0; i < 70; i++) v = encodeURIComponent(v);
    expect((await sendId(v)).r.blocked).toBeDefined();
  });

  it("a path parameter value that is not in the path template cannot block or climb anything", async () => {
    const { fetch, calls } = stub(() => res(200));
    const c = caseOf({ path: "/pets", params: { path: { id: ".." }, query: {}, header: {}, cookie: {} } });
    const [r] = await runApiCases([c], { baseUrl: BASE, fetch, guard: fastGuard() });
    expect(r!.blocked).toBeUndefined();
    expect(calls[0]!.url).toBe(`${BASE}/pets`);
  });
});

describe("limits (review)", () => {
  it("rejects an absurdly low --rps", () => {
    expect(() => parsePositiveNumber("--rps", "0.001", MIN_RPS)).toThrow(/--rps must be a number of 0.01 or more/);
    expect(parsePositiveNumber("--rps", "0.01", MIN_RPS)).toBe(0.01);
  });
});

describe("secrets, deeper (review)", () => {
  it("registers each cookie value, a decoded Basic pair, URL-encoded forms; skips trivially common values", () => {
    const basic = `Basic ${Buffer.from("alice:p@ss word").toString("base64")}`;
    const s = collectSecrets({ Cookie: "sid=abcd1234; theme=dark-mode-x", Authorization: basic, "X-Api-Key": "true" });
    expect(s).toEqual(expect.arrayContaining(["abcd1234", "dark-mode-x", "alice:p@ss word", "p@ss word", encodeURIComponent("p@ss word")]));
    expect(s).not.toContain("true");
  });

  it("names the headers whose secret is too short to be masked", () => {
    expect(tooShortSecrets({ "X-Api-Key": "abc", Authorization: "Bearer abcdefgh", "X-Plain": "x" })).toEqual(["X-Api-Key"]);
    expect(tooShortSecrets({ Authorization: "Bearer ab" })).toEqual(["Authorization"]);
  });

  it("a token echoed in a Location header is masked in the recorded redirect", async () => {
    const headers = { Authorization: "Bearer TOPSECRET123" };
    const { fetch } = stub(() => res(302, "", { location: "https://api.test/login?t=TOPSECRET123" }));
    const guard = fastGuard();
    const [r] = await runApiCases([caseOf()], { baseUrl: BASE, fetch, guard, auth: { headers }, secrets: collectSecrets(headers) });
    expect(JSON.stringify(r)).not.toContain("TOPSECRET123");
    expect(JSON.stringify(guard.report())).not.toContain("TOPSECRET123");
  });

  it("parseBaseUrl strips userinfo into a Basic credential and registers it, and registers sensitive query values", () => {
    const b = parseBaseUrl("https://bob:s3cret-pw@api.test/v1?api_key=KEYVALUE1&page=2");
    expect(b.baseUrl).toBe("https://api.test/v1?api_key=KEYVALUE1&page=2");
    expect(b.basicAuth).toBe(`Basic ${Buffer.from("bob:s3cret-pw").toString("base64")}`);
    expect(b.secrets).toEqual(expect.arrayContaining(["bob:s3cret-pw", "s3cret-pw", "KEYVALUE1"]));
    expect(b.secrets).not.toContain("2");
  });

  it.each(["//evil.example/x", "evil.example", "ftp://api.test", "javascript:alert(1)", ""])("parseBaseUrl rejects %j", (raw) => {
    expect(() => parseBaseUrl(raw)).toThrow(/--base-url must/);
  });

  it("parseBaseUrl reads `https://api.test@evil.example` as host evil.example with userinfo api.test", () => {
    expect(parseBaseUrl("https://api.test@evil.example/v1").baseUrl).toBe("https://evil.example/v1");
  });
});

describe("coverage ignores cases that were not sent (review)", () => {
  it("a skipped or blocked case does not make its operation covered", async () => {
    const model = await ingestOpenApi(join(fixtures, "servers-other-host.yaml"));
    const cases = generateApiCases(model);
    const { fetch } = stub(() => res(200, "[]"));
    const results = await runApiCases(cases, { baseUrl: BASE, fetch, guard: fastGuard() });
    const withRun = computeApiCoverage(model, cases, results);
    const without = computeApiCoverage(model, cases);
    expect(without.endpoints.find((e) => e.operationId === "createThing")!.status).toBe("covered");
    expect(withRun.endpoints.find((e) => e.operationId === "createThing")!.status).toBe("uncovered"); // POST was skipped
    expect(withRun.endpoints.find((e) => e.operationId === "listThings")!.status).toBe("covered");
  });
});
