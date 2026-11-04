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

const projectFlow = (cleanupExpect: number | number[] = 204, extraStep = false) => ({
  name: "project",
  description: "a project of the owner",
  steps: [
    { name: "create", method: "POST", path: "/api/projects", body: { name: "idor-{{uid}}" }, expect: 201, capture: { projectId: "/id" } },
    ...(extraStep ? [{ name: "broken", method: "POST", path: "/api/nowhere", expect: 201 }] : []),
  ],
  returns: ["projectId"],
  cleanup: [{ name: "delete", method: "DELETE", path: "/api/projects/{{projectId}}", expect: cleanupExpect }],
});

async function writePlan(opts: { role?: "peer" | "lower"; extraStep?: boolean; check?: Record<string, unknown> } = {}): Promise<string> {
  await mkdir(join(dir, "auth"), { recursive: true });
  // bob signs in with a saved session (cookie), alice with a token from the environment.
  await writeFile(
    join(dir, "auth", "bob.storageState.json"),
    JSON.stringify({ cookies: [{ name: "sid", value: "bob", domain: "127.0.0.1", path: "/" }], origins: [] }),
  );
  await writeFile(join(dir, "flows.json"), JSON.stringify({ version: 1, flows: [projectFlow(204, opts.extraStep)] }));
  const file = join(dir, "actors.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      flows: "flows.json",
      sessionsDir: "auth",
      actors: {
        owner: { headers: { Authorization: "Bearer {{env.ALICE_TOKEN}}" } },
        other: { session: "bob", ...(opts.role ? { role: opts.role } : {}) },
      },
      checks: [{ flow: "project", resource: "/api/projects/{{projectId}}", change: { method: "PATCH", body: { name: "taken over" } }, ...opts.check }],
    }),
  );
  return file;
}

async function run(plan: TwoActorPlan, guard = new RequestGuard({ allowMutations: true, rps: 1000 })) {
  const env = { ALICE_TOKEN: "alice-token" };
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

  it("needs --base-url", async () => {
    await expect(cairn("--actors", await writePlan())).rejects.toThrow(/--actors needs --base-url/);
  });
});
