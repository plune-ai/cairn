import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIdorApp, type IdorApp } from "../fixtures/idor-app.js";
import { RequestGuard } from "../../src/api/guard.js";
import {
  actorHeaders,
  loadTwoActorPlan,
  runTwoActorChecks,
  twoActorFailed,
  WSTG_IDOR,
  WSTG_PRIVILEGE_ESCALATION,
  type TwoActorPlan,
} from "../../src/api/two-actor.js";

/** #233: two actors against a project API with and without a deliberate IDOR (tests/fixtures/idor-app.ts). */
let app: IdorApp | undefined;
let dir: string;

/** `cleanupExpect: null` writes the cleanup step without `expect`. */
const projectFlow = (cleanupExpect: number | number[] | null = 204, extraStep = false, cleanupQuery?: Record<string, string>) => ({
  name: "project",
  description: "a project of the owner",
  steps: [
    { name: "create", method: "POST", path: "/api/projects", body: { name: "idor-{{uid}}" }, expect: 201, capture: { projectId: "/id" } },
    ...(extraStep ? [{ name: "broken", method: "POST", path: "/api/nowhere", expect: 201 }] : []),
  ],
  returns: ["projectId"],
  cleanup: [
    {
      name: "delete",
      method: "DELETE",
      path: "/api/projects/{{projectId}}",
      ...(cleanupQuery ? { query: cleanupQuery } : {}),
      ...(cleanupExpect === null ? {} : { expect: cleanupExpect }),
    },
  ],
});

async function writePlan(
  opts: {
    role?: "peer" | "lower";
    extraStep?: boolean;
    check?: Record<string, unknown>;
    cleanupExpect?: number | number[] | null;
    /** The flow file's own headers (as the flows docs show: the owner's token). */
    flowHeaders?: Record<string, string>;
    owner?: Record<string, unknown>;
    /** Query parameters of the cleanup step. */
    cleanupQuery?: Record<string, string>;
    /** More flows and checks after the project ones. */
    extraFlows?: unknown[];
    extraChecks?: unknown[];
  } = {},
): Promise<string> {
  await mkdir(join(dir, "auth"), { recursive: true });
  // bob signs in with a saved session (cookie), alice with a token from the environment.
  await writeFile(
    join(dir, "auth", "bob.storageState.json"),
    JSON.stringify({ cookies: [{ name: "sid", value: "bob", domain: "127.0.0.1", path: "/" }], origins: [] }),
  );
  await writeFile(
    join(dir, "flows.json"),
    JSON.stringify({ version: 1, ...(opts.flowHeaders ? { headers: opts.flowHeaders } : {}), flows: [projectFlow(opts.cleanupExpect === undefined ? 204 : opts.cleanupExpect, opts.extraStep, opts.cleanupQuery), ...(opts.extraFlows ?? [])] }),
  );
  const file = join(dir, "actors.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      flows: "flows.json",
      sessionsDir: "auth",
      actors: {
        owner: opts.owner ?? { headers: { Authorization: "Bearer {{env.ALICE_TOKEN}}" } },
        other: { session: "bob", ...(opts.role ? { role: opts.role } : {}) },
      },
      checks: [{ flow: "project", resource: "/api/projects/{{projectId}}", change: { method: "PATCH", body: { name: "taken over" } }, ...opts.check }, ...(opts.extraChecks ?? [])],
    }),
  );
  return file;
}

async function run(plan: TwoActorPlan, guard = new RequestGuard({ allowMutations: true, rps: 1000 }), extraEnv: Record<string, string> = {}) {
  const env = { ALICE_TOKEN: "alice-token", ...extraEnv };
  const owner = await actorHeaders(plan.file.actors.owner, plan, app!.url, env);
  const other = await actorHeaders(plan.file.actors.other, plan, app!.url, env);
  return runTwoActorChecks(plan, { baseUrl: app!.url, guard, owner, other, role: plan.file.actors.other.role, env });
}

const carolsOnly = (a: IdorApp): number[] => [...a.projects.keys()];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-two-actor-"));
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("two-actor check (#233)", () => {
  it("finds the deliberate IDOR, each finding with its WSTG id, and removes what it created", async () => {
    app = await startIdorApp({ idor: true });
    const report = await run(await loadTwoActorPlan(await writePlan()));
    const findings = report.checks[0]!.cases.filter((c) => c.outcome === "finding");
    expect(findings.map((f) => `${f.probe} ${f.method} ${f.path}`)).toEqual([
      "read GET /api/projects/3",
      "change PATCH /api/projects/3",
      "neighbours GET /api/projects/2",
      "neighbours GET /api/projects/1",
      "delete DELETE /api/projects/3",
    ]);
    expect(findings.every((f) => f.wstgId === WSTG_IDOR)).toBe(true);
    expect(report.findings).toBe(5);
    expect(twoActorFailed(report)).toBe(true);
    // bob's DELETE went through; the owner's cleanup then finds it gone, which is not a cleanup failure.
    expect(report.checks[0]!.cleanupErrors).toEqual([]);
    expect(carolsOnly(app)).toEqual([1, 2]);
  });

  it("gives zero findings when the IDOR is fixed, and removes what it created", async () => {
    app = await startIdorApp({ idor: false });
    const report = await run(await loadTwoActorPlan(await writePlan()));
    expect(report.findings).toBe(0);
    expect(report.checks[0]!.cases.map((c) => `${c.probe} ${c.outcome} ${c.status}`)).toEqual([
      "read denied 404",
      "change denied 404",
      "neighbours denied 404",
      "neighbours denied 404",
      "neighbours denied 404",
      "neighbours denied 404",
      "delete denied 404",
    ]);
    expect(twoActorFailed(report)).toBe(false);
    expect(carolsOnly(app)).toEqual([1, 2]);
    expect(app.log.at(-1)).toBe("DELETE /api/projects/3 alice");
  });

  it("removes what it created when the check fails in the middle", async () => {
    app = await startIdorApp({ idor: true, dropOn: "PATCH bob" });
    const report = await run(await loadTwoActorPlan(await writePlan()));
    expect(report.checks[0]!.error).toMatch(/PATCH \/api\/projects\/3 got no answer/);
    // The read ran before the failure; nothing after it did — but the cleanup did.
    expect(report.checks[0]!.cases.map((c) => c.probe)).toEqual(["read"]);
    expect(app.log.at(-1)).toBe("DELETE /api/projects/3 alice");
    expect(carolsOnly(app)).toEqual([1, 2]);
    expect(twoActorFailed(report)).toBe(true);
  });

  it("removes what the flow created when a later flow step fails", async () => {
    app = await startIdorApp({ idor: false });
    const report = await run(await loadTwoActorPlan(await writePlan({ extraStep: true })));
    expect(report.checks[0]!.error).toMatch(/step "broken" answered 404/);
    expect(report.checks[0]!.cases).toEqual([]);
    expect(carolsOnly(app)).toEqual([1, 2]);
  });

  it("tags the direct probes WSTG-ATHZ-03 when the other actor is a lower role", async () => {
    app = await startIdorApp({ idor: true });
    const report = await run(await loadTwoActorPlan(await writePlan({ role: "lower", check: { neighbours: 0 } })));
    expect(report.checks[0]!.cases.map((c) => `${c.probe} ${c.wstgId}`)).toEqual([
      `read ${WSTG_PRIVILEGE_ESCALATION}`,
      `change ${WSTG_PRIVILEGE_ESCALATION}`,
      `delete ${WSTG_PRIVILEGE_ESCALATION}`,
    ]);
  });

  it("sends nothing without --allow-mutations", async () => {
    app = await startIdorApp({ idor: true });
    const guard = new RequestGuard({ rps: 1000 });
    const report = await run(await loadTwoActorPlan(await writePlan()), guard);
    expect(report.checks[0]!.notRun).toMatch(/mutations disabled/);
    expect(app.log).toEqual([]);
    expect(guard.report().skipped).toEqual({ "mutations disabled": 1 });
  });

  it("does not start a check whose cleanup --allowed-methods refuses", async () => {
    app = await startIdorApp({ idor: true });
    const guard = new RequestGuard({ allowMutations: true, allowedMethods: ["GET", "POST", "PATCH"], rps: 1000 });
    const report = await run(await loadTwoActorPlan(await writePlan()), guard);
    expect(report.checks[0]!.notRun).toMatch(/sends DELETE \/api\/projects\/\{\{projectId\}\}/);
    expect(app.log).toEqual([]);
  });

  it("skips only the probe --allowed-methods refuses when the flow itself is allowed", async () => {
    app = await startIdorApp({ idor: false });
    await writePlan();
    const plan = await loadTwoActorPlan(join(dir, "actors.json"));
    const guard = new RequestGuard({ allowMutations: true, allowedMethods: ["GET", "POST", "DELETE"], rps: 1000 });
    const report = await run(plan, guard);
    expect(report.checks[0]!.cases.find((c) => c.probe === "change")).toMatchObject({ outcome: "skipped" });
    expect(app.log.some((l) => l.startsWith("PATCH"))).toBe(false);
    expect(carolsOnly(app)).toEqual([1, 2]);
  });

  it("does not start a check the request budget cannot cover", async () => {
    app = await startIdorApp({ idor: true });
    const guard = new RequestGuard({ allowMutations: true, maxRequests: 5, rps: 1000 });
    const report = await run(await loadTwoActorPlan(await writePlan()), guard);
    expect(report.checks[0]!.notRun).toMatch(/budget exhausted/);
    expect(app.log).toEqual([]);
  });
});

describe("two-actor check after review (#233)", () => {
  it("never sends the owner's token from the flow file's headers as the other actor", async () => {
    app = await startIdorApp({ idor: false });
    // The flow file carries the owner's token, as docs/api-flows.md shows; bob is given by a saved session only.
    const plan = await loadTwoActorPlan(
      await writePlan({ flowHeaders: { Authorization: "Bearer {{env.ALICE_TOKEN}}", Accept: "application/json" }, owner: { headers: { "X-Client": "cairn" } } }),
    );
    const report = await run(plan);
    // Every request after the create is bob's own until the owner's cleanup: none of them goes out as alice.
    expect(app.log.filter((l) => !l.startsWith("POST") && l !== "DELETE /api/projects/3 alice").every((l) => l.endsWith(" bob"))).toBe(true);
    expect(report.findings).toBe(0);
    expect(carolsOnly(app)).toEqual([1, 2]);
  });

  it("counts a cleanup without expect as done only on a 2xx: a 302 to the login page is a cleanup error", async () => {
    app = await startIdorApp({ idor: false, statusOn: { "DELETE alice": 302 } });
    const report = await run(await loadTwoActorPlan(await writePlan({ cleanupExpect: null })));
    expect(carolsOnly(app)).toEqual([1, 2, 3]);
    expect(report.checks[0]!.cleanupErrors).toEqual([expect.stringMatching(/DELETE \/api\/projects\/3 answered 302/)]);
    expect(twoActorFailed(report)).toBe(true);
  });

  it("calls only 401, 403 and 404 a refusal: a 422, 400, 405 or 302 to the other actor is inconclusive", async () => {
    app = await startIdorApp({ idor: false, statusOn: { "PATCH bob": 422, "GET bob": 302, "DELETE bob": 405 } });
    const report = await run(await loadTwoActorPlan(await writePlan({ check: { neighbours: 1 } })));
    expect(report.checks[0]!.cases.map((c) => `${c.probe} ${c.outcome} ${c.status}`)).toEqual([
      "read inconclusive 302",
      "change inconclusive 422",
      "neighbours inconclusive 302",
      "neighbours inconclusive 302",
      "delete inconclusive 405",
    ]);
    expect(report.checks[0]!.cases.find((c) => c.probe === "change")!.detail).toMatch(/neither a refusal/);
    expect(twoActorFailed(report)).toBe(true);
    expect(carolsOnly(app)).toEqual([1, 2]);
  });

  it("reports a cleanup that could not be sent because its value was never captured", async () => {
    app = await startIdorApp({ idor: false, createWithoutId: true });
    const report = await run(await loadTwoActorPlan(await writePlan()));
    expect(report.checks[0]!.error).toMatch(/no value at \/id/);
    // The project was created and stays: the report must say so.
    expect(carolsOnly(app)).toEqual([1, 2, 3]);
    expect(report.checks[0]!.cleanupErrors).toEqual([
      expect.stringMatching(/DELETE \/api\/projects\/\{\{projectId\}\} was not sent: \{\{projectId\}\} was never captured.*\/api\/projects\/\{\{projectId\}\}/),
    ]);
    expect(twoActorFailed(report)).toBe(true);
  });
});

/** Header names that may carry the owner's identity and that no name list can foresee. */
const IDENTITY_HEADERS = ["X-Session-Id", "X-User-Id", "X-Tenant", "X-Account", "X-Forwarded-User", "X-Remote-User", "Signature", "DPoP"];

describe("two-actor check, second review (#233)", () => {
  it.each([
    ["a plain value", (name: string) => `alice-${name.toLowerCase()}`],
    ["an {{env.}} value", () => "{{env.ALICE_TOKEN}}"],
  ])("gives the other actor only Accept, Accept-Language, Content-Type and User-Agent from the flow file's headers (%s)", async (_label, valueOf) => {
    app = await startIdorApp({ idor: false });
    const identity = Object.fromEntries(IDENTITY_HEADERS.map((n) => [n, valueOf(n)]));
    // The reviewer's flow: the owner's identity under names no strip list knows, bob signed in by his own cookie.
    const flowHeaders = {
      ...identity,
      ...(valueOf("x") === "{{env.ALICE_TOKEN}}" ? {} : { "X-Session-Id": "alice-session-1", "X-User-Id": "alice-42", "X-Tenant": "alice-tenant" }),
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const report = await run(await loadTwoActorPlan(await writePlan({ flowHeaders })));
    const bobs = app.requests.filter((r) => r.user === "bob");
    expect(bobs.length).toBe(7);
    for (const r of bobs) {
      for (const name of IDENTITY_HEADERS) expect({ [name]: r.headers[name.toLowerCase()] }).toEqual({ [name]: undefined });
      expect(JSON.stringify(r.headers)).not.toMatch(/alice/);
      expect(r.headers.accept).toBe("application/json");
      expect(r.headers["content-type"]).toBe("application/json");
      expect(r.headers.cookie).toBe("sid=bob");
    }
    // The owner's requests keep the flow file's headers.
    const create = app.requests.find((r) => r.method === "POST")!;
    expect(create.headers["x-session-id"]).toBe(flowHeaders["X-Session-Id"]!.replace("{{env.ALICE_TOKEN}}", "alice-token"));
    expect(report.findings).toBe(0);
    expect(carolsOnly(app)).toEqual([1, 2]);
  });

  it.each([404, 410])("calls a %i on cleanup a cleanup error when the other actor's DELETE did not go through", async (code) => {
    app = await startIdorApp({ idor: false, statusOn: { "DELETE alice": code } });
    const report = await run(await loadTwoActorPlan(await writePlan()));
    expect(report.checks[0]!.cases.find((c) => c.probe === "delete")).toMatchObject({ outcome: "denied", status: 404 });
    expect(report.checks[0]!.cleanupErrors).toEqual([expect.stringMatching(new RegExp(`DELETE /api/projects/3 answered ${code}`))]);
    expect(twoActorFailed(report)).toBe(true);
    // The resource is still there, and the report says so.
    expect(carolsOnly(app)).toEqual([1, 2, 3]);
  });

  it("does not report a cleanup error for a check that sent nothing, after a check that did", async () => {
    app = await startIdorApp({ idor: false });
    const brokenFlow = {
      name: "broken",
      steps: [{ name: "create", method: "POST", path: "/api/projects", body: { name: "{{env.CAIRN_TEST_NEVER_SET}}" }, expect: 201, capture: { projectId: "/id" } }],
      returns: ["projectId"],
      cleanup: [{ name: "delete", method: "DELETE", path: "/api/projects/{{projectId}}", expect: 204 }],
    };
    const plan = await loadTwoActorPlan(await writePlan({ extraFlows: [brokenFlow], extraChecks: [{ flow: "broken", resource: "/api/projects/{{projectId}}" }] }));
    const report = await run(plan);
    expect(report.checks[0]!.error).toBeUndefined();
    expect(report.checks[0]!.cleanupErrors).toEqual([]);
    expect(report.checks[1]!.error).toMatch(/CAIRN_TEST_NEVER_SET is not set/);
    // The second check sent nothing, so nothing of it can be left on the server.
    expect(app.log.filter((l) => l.startsWith("POST"))).toHaveLength(1);
    expect(report.checks[1]!.cleanupErrors).toEqual([]);
    expect(carolsOnly(app)).toEqual([1, 2]);
  });
});

describe("cairn api --actors (#233)", () => {
  let outChunks: string[];
  let errChunks: string[];
  let spies: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    outChunks = [];
    errChunks = [];
    spies = [
      vi.spyOn(process.stdout, "write").mockImplementation((c) => (outChunks.push(c.toString()), true)),
      vi.spyOn(process.stderr, "write").mockImplementation((c) => (errChunks.push(c.toString()), true)),
    ];
    process.exitCode = 0;
    process.env.ALICE_TOKEN = "alice-token";
  });
  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    process.exitCode = 0;
    delete process.env.ALICE_TOKEN;
    vi.resetModules();
  });
  const cairn = async (...args: string[]): Promise<void> => {
    const { buildProgram } = await import("../../src/cli/index.js");
    await buildProgram().parseAsync(["node", "cairn", "api", ...args]);
  };

  it("reports the IDOR with its WSTG id, exits 1, writes two-actor.json without the token", async () => {
    app = await startIdorApp({ idor: true });
    const file = await writePlan();
    const out = join(dir, "run");
    await cairn("--base-url", app.url, "--actors", file, "--allow-mutations", "--rps", "1000", "--out", out);
    const text = outChunks.join("");
    expect(text).toContain(`✗ [${WSTG_IDOR}] read: GET /api/projects/3`);
    expect(text).toContain("5 finding(s)");
    expect(process.exitCode).toBe(1);
    const saved = await readFile(join(out, "two-actor.json"), "utf8");
    expect(JSON.parse(saved)).toMatchObject({ mode: "api-two-actor", findings: 5 });
    expect(saved + text).not.toContain("alice-token");
    expect(carolsOnly(app)).toEqual([1, 2]);
  });

  it("exits 0 against the fixed server", async () => {
    app = await startIdorApp({ idor: false });
    await cairn("--base-url", app.url, "--actors", await writePlan(), "--allow-mutations", "--rps", "1000", "--out", join(dir, "run"));
    expect(outChunks.join("")).toContain("0 finding(s)");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("sends nothing and exits 5 without --allow-mutations", async () => {
    app = await startIdorApp({ idor: true });
    await cairn("--base-url", app.url, "--actors", await writePlan(), "--rps", "1000", "--out", join(dir, "run"));
    expect(errChunks.join("")).toContain("needs --allow-mutations");
    expect(app.log).toEqual([]);
    expect(process.exitCode).toBe(5);
  });

  it.each([500, 409])("calls a neighbour inconclusive and exits 1 when the owner's read of it answers %i", async (code) => {
    // bob reads carol's project 2 (the deliberate IDOR); the owner's read of it answers neither a refusal nor a success.
    app = await startIdorApp({ idor: true, statusOn: { "GET alice": code } });
    const file = await writePlan({ check: { probes: ["neighbours"], neighbours: 1 } });
    const out = join(dir, "run");
    await cairn("--base-url", app.url, "--actors", file, "--allow-mutations", "--rps", "1000", "--out", out);
    const report = JSON.parse(await readFile(join(out, "two-actor.json"), "utf8")) as { checks: { cases: { path: string; outcome: string; ownerStatus?: number }[] }[] };
    expect(report.checks[0]!.cases.map((c) => `${c.path} ${c.outcome} ${c.ownerStatus ?? "-"}`)).toEqual([
      `/api/projects/2 inconclusive ${code}`,
      "/api/projects/4 denied -",
    ]);
    expect(outChunks.join("")).toContain(`? [${WSTG_IDOR}] neighbours: GET /api/projects/2`);
    expect(process.exitCode).toBe(1);
    expect(carolsOnly(app)).toEqual([1, 2]);
  });

  it("names a cleanup's path as the flow file wrote it: an {{env.}} secret in its query never reaches the report", async () => {
    app = await startIdorApp({ idor: false, statusOn: { "DELETE alice": 500 } });
    process.env.CAIRN_TEST_API_TOKEN = "q-secret-7f3a9";
    try {
      const file = await writePlan({ cleanupQuery: { token: "{{env.CAIRN_TEST_API_TOKEN}}" } });
      const out = join(dir, "run");
      await cairn("--base-url", app.url, "--actors", file, "--allow-mutations", "--rps", "1000", "--out", out);
      // The secret went on the wire, where it belongs …
      expect(app.requests.find((r) => r.method === "DELETE" && r.user === "alice")!.url).toBe("/api/projects/3?token=q-secret-7f3a9");
      // … and the cleanup error names method, path and status without it.
      const saved = await readFile(join(out, "two-actor.json"), "utf8");
      const text = outChunks.join("") + errChunks.join("");
      const line = "DELETE /api/projects/3?token={{env.CAIRN_TEST_API_TOKEN}} answered 500";
      expect((JSON.parse(saved) as { checks: { cleanupErrors: string[] }[] }).checks[0]!.cleanupErrors).toEqual([expect.stringContaining(line)]);
      expect(text).toContain(line);
      expect(saved + text).not.toContain("q-secret-7f3a9");
      expect(process.exitCode).toBe(1);
    } finally {
      delete process.env.CAIRN_TEST_API_TOKEN;
    }
  });

  it("needs --base-url", async () => {
    await expect(cairn("--actors", await writePlan())).rejects.toThrow(/--actors needs --base-url/);
  });
});
