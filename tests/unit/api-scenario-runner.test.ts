import { describe, it, expect } from "vitest";
import { runApiScenarios } from "../../src/api/scenario-runner.js";
import type { ApiCase } from "../../src/api/cases.js";
import type { ApiScenario } from "../../src/api/scenarios.js";
import type { FetchLike, ResponseLike } from "../../src/api/runner.js";

/**
 * C1-04 / API-9 (#146): the scenario runner threads a captured response value into a downstream
 * step, aborts (and marks "skipped") the rest of a scenario when a step fails, and prefers a declared
 * `links` expression over the name-match fallback when both would apply.
 */

function fakeFetch(handler: (url: string, init: RequestInit) => ResponseLike): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}

function res(status: number, body: unknown = ""): ResponseLike {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => text };
}

function step(over: Partial<ApiCase>): ApiCase {
  return {
    name: "step",
    method: "GET",
    path: "/x",
    params: { path: {}, query: {}, header: {}, cookie: {} },
    expectedStatus: "200",
    type: "Positive",
    technique: "state-transition",
    rationale: "test",
    ...over,
  } as ApiCase;
}

function scenarioOf(steps: ApiCase[]): ApiScenario {
  return { name: "test lifecycle", steps, technique: "state-transition", rationale: "test" };
}

describe("runApiScenarios — capture + thread + abort (API-9, #146)", () => {
  it("captures a response field by name and threads it into a later step's path param (fallback heuristic)", async () => {
    const create = step({ name: "create", method: "POST", path: "/items", expectedStatus: "201" });
    const read = step({ name: "read", method: "GET", path: "/items/{id}", params: { path: { id: "PLACEHOLDER" }, query: {}, header: {}, cookie: {} } });
    const { fetch, calls } = fakeFetch((url) => (url.endsWith("/items") ? res(201, { id: "42", name: "widget" }) : res(200, { id: "42" })));

    const [result] = await runApiScenarios([scenarioOf([create, read])], { baseUrl: "https://api.test", fetch });

    expect(calls[1]!.url).toBe("https://api.test/items/42"); // captured id, not "PLACEHOLDER"
    expect(result!.passed).toBe(true);
    expect(result!.steps.map((s) => s.passed)).toEqual([true, true]);
  });

  it("prefers a declared `links` expression over the same-name-field fallback", async () => {
    const create = step({
      name: "create",
      method: "POST",
      path: "/items",
      expectedStatus: "201",
      responseLinks: { GetItem: { operationId: "getItem", parameters: { id: "$response.body#/realId" } } },
    });
    const read = step({
      name: "read",
      method: "GET",
      path: "/items/{id}",
      operationId: "getItem",
      params: { path: { id: "PLACEHOLDER" }, query: {}, header: {}, cookie: {} },
    });
    // Response has both a decoy top-level "id" and the link-targeted "realId" — the link must win.
    const { fetch, calls } = fakeFetch((url) => (url.endsWith("/items") ? res(201, { id: "decoy", realId: "99" }) : res(200, {})));

    await runApiScenarios([scenarioOf([create, read])], { baseUrl: "https://api.test", fetch });

    expect(calls[1]!.url).toBe("https://api.test/items/99");
  });

  it("aborts the rest of the scenario when a step fails, marking later steps skipped", async () => {
    const create = step({ name: "create", method: "POST", path: "/items", expectedStatus: "201" });
    const read = step({ name: "read", method: "GET", path: "/items/{id}", params: { path: { id: "x" }, query: {}, header: {}, cookie: {} } });
    const del = step({ name: "delete", method: "DELETE", path: "/items/{id}", expectedStatus: "204", params: { path: { id: "x" }, query: {}, header: {}, cookie: {} } });
    // create fails its status assertion (500, not the declared 201) — read/delete must never fire.
    const { fetch, calls } = fakeFetch(() => res(500, { error: "boom" }));

    const [result] = await runApiScenarios([scenarioOf([create, read, del])], { baseUrl: "https://api.test", fetch, retries: 0 });

    expect(calls).toHaveLength(1); // only the failing create step actually made a request
    expect(result!.passed).toBe(false);
    expect(result!.steps[0]!.passed).toBe(false);
    expect(result!.steps[1]!.error).toMatch(/^skipped/);
    expect(result!.steps[1]!.passed).toBe(false);
    expect(result!.steps[2]!.error).toMatch(/^skipped/);
  });

  it("a fully-passing scenario is passed=true; every step reused the normal runner (auth/redaction apply)", async () => {
    const create = step({ name: "create", method: "POST", path: "/items", expectedStatus: "201" });
    const { fetch } = fakeFetch(() => res(201, { id: "1" }));

    const [result] = await runApiScenarios([scenarioOf([create])], {
      baseUrl: "https://api.test",
      fetch,
      auth: { headers: { Authorization: "Bearer secret" } },
    });

    expect(result!.passed).toBe(true);
    expect(result!.steps[0]!.request.headers["Authorization"]).toBe("***"); // same redaction as runApiCases
  });
});
