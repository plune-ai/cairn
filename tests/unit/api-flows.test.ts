import { describe, it, expect, vi, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";
import { ingestOpenApi } from "../../src/api/openapi.js";
import { generateApiScenarios } from "../../src/api/scenarios.js";
import {
  parseApiFlows,
  flowChangesData,
  flowEnvSecrets,
  flowsFromScenarios,
  mergeApiFlows,
  renderFlowFixture,
  formatFlowsForPrompt,
  FLOW_FIXTURE_FILE,
  type ApiFlowFile,
} from "../../src/api/flows.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

/** #230: create a project → return its id → delete it, plus a sign-in through the API. */
const projectFlows = {
  version: 1,
  baseUrl: "http://127.0.0.1:4000",
  flows: [
    {
      name: "project",
      description: "a project to open in the UI",
      steps: [
        {
          name: "create project",
          method: "POST",
          path: "/api/projects",
          body: { name: "Project {{uid}}" },
          expect: 201,
          capture: { projectId: "/id", projectName: "$response.body#/name" },
        },
      ],
      returns: ["projectId", "projectName"],
      cleanup: [{ name: "delete project", method: "DELETE", path: "/api/projects/{{projectId}}", expect: [204, 404] }],
    },
    {
      name: "signedIn",
      kind: "signin",
      steps: [{ method: "POST", path: "/api/login", form: { user: "{{env.APP_USER}}", password: "{{env.APP_PASSWORD}}" } }],
    },
  ],
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("parseApiFlows — the flow file (#230)", () => {
  it("reads a flow with its steps, what it returns and its cleanup", () => {
    const file = parseApiFlows(JSON.stringify(projectFlows));
    const project = file.flows.find((f) => f.name === "project")!;
    expect(project.kind).toBe("data");
    expect(project.returns).toEqual(["projectId", "projectName"]);
    expect(project.cleanup.map((s) => s.method)).toEqual(["DELETE"]);
    expect(file.flows.find((f) => f.name === "signedIn")!.kind).toBe("signin");
  });

  it("refuses a flow that changes data and has no cleanup", () => {
    const bad = clone(projectFlows);
    bad.flows[0]!.cleanup = [];
    expect(() => parseApiFlows(JSON.stringify(bad))).toThrow(/"project" changes data but has no cleanup/);
  });

  it("refuses a returned value that no step captures", () => {
    const bad = clone(projectFlows);
    bad.flows[0]!.returns = ["projectId", "ownerId"];
    expect(() => parseApiFlows(JSON.stringify(bad))).toThrow(/"project" returns "ownerId", which no step captures/);
  });

  it("refuses a template that names a value not captured before it", () => {
    const bad = clone(projectFlows);
    bad.flows[0]!.cleanup[0]!.path = "/api/projects/{{projectKey}}";
    expect(() => parseApiFlows(JSON.stringify(bad))).toThrow(/\{\{projectKey\}\}/);
  });

  it("refuses a secret written into the file instead of {{env.NAME}}", () => {
    const bad = clone(projectFlows) as typeof projectFlows & { headers?: Record<string, string> };
    bad.headers = { Authorization: "Bearer abc123" };
    expect(() => parseApiFlows(JSON.stringify(bad))).toThrow(/Authorization.*\{\{env\.NAME\}\}/);
    const badForm = clone(projectFlows);
    badForm.flows[1]!.steps[0]!.form = { user: "me", password: "hunter2" };
    expect(() => parseApiFlows(JSON.stringify(badForm))).toThrow(/password.*\{\{env\.NAME\}\}/);
  });

  it("refuses a name Playwright already uses as a fixture, and two sign-in flows", () => {
    const reserved = clone(projectFlows);
    reserved.flows[0]!.name = "page";
    expect(() => parseApiFlows(JSON.stringify(reserved))).toThrow(/"page" is a Playwright fixture/);
    const twoSignins = clone(projectFlows);
    twoSignins.flows.push({ ...clone(projectFlows.flows[1]!), name: "admin" });
    expect(() => parseApiFlows(JSON.stringify(twoSignins))).toThrow(/at most one sign-in flow/);
  });

  it("refuses a path that is not relative to the base URL", () => {
    const bad = clone(projectFlows);
    bad.flows[0]!.steps[0]!.path = "https://elsewhere.example/api/projects";
    expect(() => parseApiFlows(JSON.stringify(bad))).toThrow(/path/);
  });
});

describe("parseApiFlows — review findings (#230)", () => {
  const signinWith = (steps: unknown[], cleanup?: unknown[]): string =>
    JSON.stringify({ version: 1, flows: [{ name: "signedIn", kind: "signin", steps, ...(cleanup ? { cleanup } : {}) }] });
  const login = { method: "POST", path: "/api/login", form: { user: "{{env.U}}", password: "{{env.P}}" } };

  it("a sign-in flow may change data once (the login), not twice, and has no cleanup", () => {
    expect(() => parseApiFlows(signinWith([login, { method: "GET", path: "/api/me" }]))).not.toThrow();
    expect(() => parseApiFlows(signinWith([login, { method: "DELETE", path: "/api/projects/everything" }]))).toThrow(
      /sign-in flow sends one request that changes data/,
    );
    expect(() => parseApiFlows(signinWith([login], [{ method: "DELETE", path: "/api/sessions" }]))).toThrow(/sign-in flow has no cleanup/);
  });

  it("refuses literal secrets in query, path, nested body keys and around {{env.NAME}} in a header", () => {
    const withStep = (step: Record<string, unknown>): string =>
      JSON.stringify({ version: 1, flows: [{ name: "health", steps: [{ method: "GET", path: "/health", ...step }] }] });
    expect(() => parseApiFlows(withStep({ query: { api_key: "sk_live_QUERY" } }))).toThrow(/"api_key" holds a secret/);
    expect(() => parseApiFlows(withStep({ path: "/x?access_token=sk_live_PATH" }))).toThrow(/query parameters go in "query"/);
    expect(() => parseApiFlows(withStep({ method: "POST", body: { pwd: "hunter2" } }))).toThrow(/"pwd" holds a secret/);
    expect(() => parseApiFlows(withStep({ method: "POST", body: { credentials: { pass: "hunter3" } } }))).toThrow(
      /"credentials\.pass" holds a secret/,
    );
    expect(() => parseApiFlows(withStep({ headers: { Authorization: "Bearer sk_live_REAL {{env.X}}" } }))).toThrow(
      /header "Authorization" holds a secret/,
    );
    // the allowed shapes still pass
    expect(() =>
      parseApiFlows(withStep({ query: { api_key: "{{env.KEY}}", compass: "north", author: "Ada" }, headers: { Authorization: "Bearer {{env.X}}" } })),
    ).not.toThrow();
  });

  it("refuses two flows whose fixture types would share a name", () => {
    const two = JSON.stringify({ version: 1, flows: [{ name: "a", steps: [{ method: "GET", path: "/a" }] }, { name: "A", steps: [{ method: "GET", path: "/a" }] }] });
    expect(() => parseApiFlows(two)).toThrow(/type AFlow is also flow "a"'s/);
  });
});

describe("flowChangesData — what needs the explicit flag (#230)", () => {
  it("a data flow with a POST/PUT/PATCH/DELETE changes data; a GET-only flow and a sign-in do not", () => {
    const file = parseApiFlows(JSON.stringify(projectFlows));
    expect(flowChangesData(file.flows.find((f) => f.name === "project")!)).toBe(true);
    expect(flowChangesData(file.flows.find((f) => f.name === "signedIn")!)).toBe(false);
    const readOnly = parseApiFlows(
      JSON.stringify({ version: 1, flows: [{ name: "health", steps: [{ method: "GET", path: "/health" }] }] }),
    );
    expect(flowChangesData(readOnly.flows[0]!)).toBe(false);
  });

  it("a flow whose steps only read but whose cleanup deletes changes data too", () => {
    const file = parseApiFlows(
      JSON.stringify({
        version: 1,
        flows: [
          { name: "existing", steps: [{ method: "GET", path: "/api/projects/latest", capture: { id: "/id" } }], returns: ["id"], cleanup: [{ method: "DELETE", path: "/api/projects/{{id}}" }] },
        ],
      }),
    );
    expect(flowChangesData(file.flows[0]!)).toBe(true);
    expect(renderFlowFixture(file, {})).toMatch(/"changesData": true/);
  });
});

describe("flowsFromScenarios — save a scenario chain as a flow (#230)", () => {
  it("keeps the create step, returns the id the delete needs and makes the delete its cleanup", async () => {
    const model = await ingestOpenApi(join(fixtures, "crud-store.yaml"));
    const { flows, notSaved } = flowsFromScenarios(generateApiScenarios(model));
    const items = flows.find((f) => f.name === "items")!;
    expect(items.steps.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /items"]);
    expect(items.steps[0]!.capture).toEqual({ id: "/id" }); // the declared link
    expect(items.returns).toEqual(["id"]);
    expect(items.cleanup.map((s) => `${s.method} ${s.path}`)).toEqual(["DELETE /items/{{id}}"]);
    // a chain with nothing that deletes what it creates is not saved
    expect(flows.every((f) => f.cleanup.length > 0)).toBe(true);
    expect(notSaved.every((n) => /no DELETE/.test(n.reason))).toBe(true);
    // what was saved reads back as a valid flow file
    expect(() => parseApiFlows(JSON.stringify({ version: 1, flows }))).not.toThrow();
  });

  it("merging keeps the flows already in the file and replaces the ones with the same name", () => {
    const existing = parseApiFlows(JSON.stringify(projectFlows));
    const merged = mergeApiFlows(existing, [{ ...existing.flows[0]!, description: "new" }]);
    expect(merged.flows.map((f) => f.name)).toEqual(["project", "signedIn"]);
    expect(merged.flows[0]!.description).toBe("new");
    expect(merged.baseUrl).toBe("http://127.0.0.1:4000");
  });
});

describe("renderFlowFixture — the Playwright fixture (#230)", () => {
  const file = parseApiFlows(JSON.stringify(projectFlows));

  it("extends test with one fixture per flow and hands over the sign-in as storageState", () => {
    const ts = renderFlowFixture(file, {});
    expect(FLOW_FIXTURE_FILE).toBe("api-flows.fixture.ts");
    expect(ts).toContain("export const test = base.extend<");
    expect(ts).toMatch(/project: async \(\{ playwright, baseURL, storageState \}, use, testInfo\) =>/);
    expect(ts).toMatch(/storageState: async \(\{ playwright, baseURL \}, use\) =>/);
    expect(ts).toContain("export type ProjectFlow = { projectId: string; projectName: string };");
    expect(ts).toContain("export { expect };");
  });

  it("runs the cleanup in a finally, so it runs after a failed test too", () => {
    const ts = renderFlowFixture(file, {});
    expect(ts).toMatch(/await use\(pick\(vars, flow\.returns\)\);\s*\} finally \{/);
  });

  it("allows no address to be changed unless the flag named one; env values are never written", () => {
    const locked = renderFlowFixture(file, {});
    expect(locked).toContain("const MUTATIONS_ALLOWED_FOR: string[] = [];");
    const open = renderFlowFixture(file, { allowMutationsFor: "http://127.0.0.1:4000/api" });
    expect(open).toContain('const MUTATIONS_ALLOWED_FOR: string[] = ["http://127.0.0.1:4000"];');
    expect(open).not.toMatch(/hunter2|APP_PASSWORD"?\s*:/);
    expect(open).toContain("{{env.APP_PASSWORD}}");
  });

  it("writes the source name into its comment on one line, whatever characters it holds", () => {
    const ts = renderFlowFixture(file, { source: "flows.json\nprocess.exit(1);\u2028x" });
    expect(ts.split("\n")[0]).toMatch(/^\/\/ Playwright fixtures for the API flows in flows\.json process\.exit\(1\); x/);
    expect(ts).not.toMatch(/^process\.exit/m);
  });

  it("uses the given base URL when the file names none", () => {
    const noBase = parseApiFlows(JSON.stringify({ ...projectFlows, baseUrl: undefined }));
    expect(renderFlowFixture(noBase, { baseUrl: "http://localhost:9000" })).toContain(
      'const DEFAULT_BASE_URL: string | undefined = "http://localhost:9000";',
    );
  });
});

/**
 * The written fixture module as it runs: transpiled, with a stand-in for `@playwright/test` and for the request
 * context, so its error text is read from what it really throws. Resolves to the message it fails with.
 */
function failureOf(file: ApiFlowFile, fetch: (url: string) => Promise<unknown> = async () => ({ status: () => 200 })): (flow: string) => Promise<string> {
  const js = ts.transpileModule(renderFlowFixture(file, { baseUrl: "http://api.test", allowMutationsFor: "http://api.test" }), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod: { test?: Record<string, (args: unknown, use: () => Promise<void>, info: unknown) => Promise<void>> } = {};
  new Function("require", "exports", js)(() => ({ test: { extend: (fixtures: unknown) => fixtures } }), mod);
  const args = { playwright: { request: { newContext: async () => ({ fetch, dispose: async () => undefined }) } } };
  return (flow) =>
    mod.test![flow]!(args, async () => undefined, {}).then(
      () => "(it did not fail)",
      (e: Error) => e.message,
    );
}

describe("the fixture's error text holds no value (#250)", () => {
  const SECRET = "S3CRET-q7";
  /** What Playwright 1.61 throws for a request that gets no answer: the call log has the URL and every header. */
  const noAnswer = (first: string): Error =>
    new Error(
      `apiRequestContext.fetch: ${first}\nCall log:\n\u001b[2m  - → GET http://api.test/api/${SECRET}\u001b[22m\n\u001b[2m    - Authorization: Bearer ${SECRET}\u001b[22m\n`,
    );
  const flowOf = (flow: Record<string, unknown>): ApiFlowFile => parseApiFlows(JSON.stringify({ version: 1, flows: [{ name: "thing", ...flow }] }));
  const read = (path: string): Record<string, unknown> => ({ method: "GET", path });
  afterEach(() => void vi.unstubAllEnvs());

  it("names an environment value that cannot stand in the path, never prints it", async () => {
    vi.stubEnv("SEG", `sec/${SECRET}`);
    const message = await failureOf(flowOf({ steps: [read("/api/{{env.SEG}}/items")] }))("thing");
    expect(message).toBe("API flow: {{env.SEG}} is a value, which cannot stand in the path /api/{{env.SEG}}/items");
  });

  it("names a captured value that cannot stand in the path, never prints it", async () => {
    const answer = { status: () => 200, json: async () => ({ link: `x/${SECRET}` }), text: async () => JSON.stringify({ link: `x/${SECRET}` }) };
    const file = flowOf({ steps: [{ ...read("/api/links"), capture: { link: "/link" } }, read("/api/{{link}}")] });
    const message = await failureOf(file, async () => answer)("thing");
    expect(message).toBe("API flow: {{link}} is a value, which cannot stand in the path /api/{{link}}");
  });

  it.each([
    ["connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED"],
    ["getaddrinfo ENOTFOUND api.test", "ENOTFOUND"],
    ["Timeout 30000ms exceeded.", "timeout"],
    [`self-signed certificate ${SECRET}`, "network error"],
  ])("a request that fails with %s says only why, without Playwright's text", async (first, why) => {
    const file = flowOf({ steps: [{ ...read("/api/{{env.SEG}}"), name: "read it" }] });
    vi.stubEnv("SEG", SECRET);
    const message = await failureOf(file, async () => Promise.reject(noAnswer(first)))("thing");
    expect(message).toBe(`API flow "thing" step "read it" got no answer: ${why}`);
  });

  it("a cleanup request that fails says the same, and that the data may still be there", async () => {
    const file = flowOf({ steps: [{ method: "POST", path: "/api/things" }], cleanup: [{ method: "DELETE", path: "/api/things/1", name: "delete it" }] });
    const fetch = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValueOnce({ status: () => 201 }).mockRejectedValueOnce(noAnswer("connect ECONNREFUSED 127.0.0.1:1"));
    const message = await failureOf(file, fetch)("thing");
    expect(message).toBe('API flow "thing": the cleanup failed, the data may still be there\nAPI flow "thing" step "delete it" got no answer: ECONNREFUSED');
  });
});

describe("the fixture uses a captured number only as the server wrote it (#253)", () => {
  /** A create that answers `json`, a read of what it created, and a delete of it as the cleanup; the URLs it sent. */
  const run = async (json: string, capture: Record<string, string> = { id: "/id" }) => {
    const file = parseApiFlows(
      JSON.stringify({
        version: 1,
        flows: [
          {
            name: "thing",
            steps: [{ method: "POST", path: "/api/things", capture }, { method: "GET", path: "/api/things/{{id}}" }],
            returns: ["id"],
            cleanup: [{ method: "DELETE", path: "/api/things/{{id}}" }],
          },
        ],
      }),
    );
    const urls: string[] = [];
    const fetch = async (url: string, init?: { method?: string }) => {
      urls.push(`${init?.method} ${new URL(url).pathname}`);
      return { status: () => 201, json: async () => JSON.parse(json) as unknown, text: async () => json };
    };
    return { message: await failureOf(file, fetch)("thing"), urls };
  };

  it.each([
    ["above 2^53", "9007199254740993"],
    ["too large to hold (1e400 parses as Infinity)", "1e400"],
    ["too far below zero to hold", "-1e400"],
    ["a fraction JSON.parse reads as the largest safe integer", "9007199254740991.4"],
    ["more digits than a number holds, read as 3", "3.0000000000000000001"],
  ])("a captured number %s is not used: no read and no delete can reach another record", async (_label, n) => {
    const { message, urls } = await run(`{"id":${n}}`);
    expect(message).toBe('API flow "thing" step "POST /api/things": {{id}} is not a safe integer (the number may have been rounded), so it is not used');
    expect(urls).toEqual(["POST /api/things"]);
  });

  it("keeps the other captures of that answer, so the cleanup still goes to the created record", async () => {
    const { message, urls } = await run('{"id":3,"size":9007199254740993}', { id: "/id", size: "/size" });
    expect(message).toMatch(/\{\{size\}\} is not a safe integer/);
    expect(urls).toEqual(["POST /api/things", "DELETE /api/things/3"]);
  });

  it.each([
    ["the largest safe integer", "9007199254740991", "9007199254740991"],
    ["a fraction a number holds", "3.5", "3.5"],
    ["a whole number written with a fraction or an exponent", "30e-1", "3"],
    ["zeros after the point", "3.50", "3.5"],
  ])("takes %s", async (_label, n, sent) => {
    const { message, urls } = await run(`{"id":${n}}`);
    expect(message).toBe("(it did not fail)");
    expect(urls).toEqual(["POST /api/things", `GET /api/things/${sent}`, `DELETE /api/things/${sent}`]);
  });
});

describe("a template in a key (#253)", () => {
  it("is refused when the file is read: a key goes out as written, so nothing fills it", () => {
    for (const where of ["headers", "query", "form"] as const) {
      const bad = clone(projectFlows) as { flows: { cleanup: Record<string, unknown>[] }[] };
      bad.flows[0]!.cleanup[0]![where] = { "{{nope}}": "1" };
      expect(() => parseApiFlows(JSON.stringify(bad))).toThrow('flow "project" cleanup 1: {{nope}} is in a key; only values are filled, so write the key as it goes out');
    }
    const body = clone(projectFlows) as { flows: { steps: Record<string, unknown>[] }[] };
    body.flows[0]!.steps[0]!.body = { name: "x", tags: [{ "{{ uid }}": 1 }] };
    expect(() => parseApiFlows(JSON.stringify(body))).toThrow('flow "project" step 1: {{uid}} is in a key');
    const fileHeaders = { ...clone(projectFlows), headers: { "X-{{env.H}}": "1" } };
    expect(() => parseApiFlows(JSON.stringify(fileHeaders))).toThrow("headers: {{env.H}} is in a key");
  });

  it("does not keep the written fixture from sending a cleanup step: it reads values only, as the file check does", async () => {
    const file = parseApiFlows(JSON.stringify(projectFlows));
    // Built past parseApiFlows (which refuses it) to prove the fixture itself reads it as the two-actor check does.
    file.flows[0]!.cleanup[0]!.query = { "{{nope}}": "1" };
    const methods: string[] = [];
    const fetch = async (_url: string, init?: { method?: string }) => {
      methods.push(init?.method ?? "");
      return { status: () => (init?.method === "POST" ? 201 : 204), json: async () => ({ id: 3, name: "x" }), text: async () => '{"id":3,"name":"x"}' };
    };
    expect(await failureOf(file, fetch)("project")).toBe("(it did not fail)");
    expect(methods).toEqual(["POST", "DELETE"]);
  });
});

describe("flowEnvSecrets — what a run must not repeat (#250)", () => {
  afterEach(() => void vi.unstubAllEnvs());

  it("each {{env.NAME}} anywhere in the file, as written and as it goes on the wire; nothing else of the environment", () => {
    const file = parseApiFlows(
      JSON.stringify({
        version: 1,
        headers: { Authorization: "Bearer {{env.TOKEN}}" },
        flows: [
          {
            name: "thing",
            steps: [{ method: "POST", path: "/{{env.SEG}}", form: { pin: "{{env.PIN}}" }, capture: { id: "/id" } }],
            cleanup: [{ method: "DELETE", path: "/x/{{id}}", query: { key: "{{env.KEY}}" } }],
          },
        ],
      }),
    );
    const env = { TOKEN: "tok-en-1", SEG: 'a b/c"d!', PIN: "pin-99", KEY: "cleanup-key", OTHER: "not-named-here" };
    const secrets = flowEnvSecrets(file, env);
    expect(secrets).toEqual(expect.arrayContaining(["tok-en-1", "pin-99", "cleanup-key", 'a b/c"d!']));
    expect(secrets).toContain("a%20b%2Fc%22d!"); // a path
    expect(secrets).toContain("a+b%2Fc%22d%21"); // a query or a form
    expect(secrets).toContain('a b/c\\"d!'); // a JSON body
    expect(secrets).not.toContain("not-named-here");
  });

  it("leaves out what is not set, and what is too short or too common to mask without mangling the text", () => {
    const file = parseApiFlows(
      JSON.stringify({
        version: 1,
        flows: [{ name: "thing", steps: [{ method: "GET", path: "/{{env.A}}/{{env.B}}/{{env.C}}/{{env.D}}" }] }],
      }),
    );
    expect(flowEnvSecrets(file, { A: "ab", B: "true", C: "" })).toEqual([]);
  });
});

describe("a flow file that is not JSON (#250)", () => {
  it("names the file and repeats none of its text: nothing has checked yet that it holds no secret", () => {
    const text = '{"version":1,"headers":{"X-Api-Key":S3CRET-q7},"flows":[]}';
    expect(() => parseApiFlows(text, "flows.json")).toThrow(/^flows\.json is not valid JSON\.$/);
  });
});

describe("formatFlowsForPrompt — what design and automate are told (#230)", () => {
  it("names each flow, what it returns and what it cleans up", () => {
    const text = formatFlowsForPrompt(parseApiFlows(JSON.stringify(projectFlows)));
    expect(text).toContain("- project (creates data; returns projectId, projectName; its cleanup deletes it afterwards) — a project to open in the UI");
    expect(text).toContain("- signedIn (signs in through the API; the test starts with its session as storageState)");
  });
});
