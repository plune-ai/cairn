import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingestOpenApi } from "../../src/api/openapi.js";
import { generateApiScenarios } from "../../src/api/scenarios.js";
import {
  parseApiFlows,
  flowChangesData,
  flowsFromScenarios,
  mergeApiFlows,
  renderFlowFixture,
  formatFlowsForPrompt,
  FLOW_FIXTURE_FILE,
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

describe("formatFlowsForPrompt — what design and automate are told (#230)", () => {
  it("names each flow, what it returns and what it cleans up", () => {
    const text = formatFlowsForPrompt(parseApiFlows(JSON.stringify(projectFlows)));
    expect(text).toContain("- project (creates data; returns projectId, projectName; its cleanup deletes it afterwards) — a project to open in the UI");
    expect(text).toContain("- signedIn (signs in through the API; the test starts with its session as storageState)");
  });
});
