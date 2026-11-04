import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApiFlows } from "../../src/api/flows.js";
import { actorHeaders, cookieHeaderFor, parseTwoActorFile, type TwoActorPlan } from "../../src/api/two-actor.js";

/** #233: the two-actor file is checked against its flow file before anything is sent. */
const flows = parseApiFlows(
  JSON.stringify({
    version: 1,
    flows: [
      {
        name: "project",
        steps: [{ method: "POST", path: "/api/projects", body: { name: "x" }, capture: { projectId: "/id" } }],
        returns: ["projectId"],
        cleanup: [{ method: "DELETE", path: "/api/projects/{{projectId}}" }],
      },
      { name: "signedIn", kind: "signin", steps: [{ method: "POST", path: "/login", form: { user: "{{env.U}}" } }] },
    ],
  }),
);

const file = (patch: Record<string, unknown> = {}, check: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    flows: "flows.json",
    actors: { owner: { session: "alice" }, other: { session: "bob" } },
    checks: [{ flow: "project", resource: "/api/projects/{{projectId}}", ...check }],
    ...patch,
  });

describe("parseTwoActorFile (#233)", () => {
  it("fills the defaults: a peer, every probe, two neighbours, PATCH {}", () => {
    const f = parseTwoActorFile(file(), flows);
    expect(f.actors.other.role).toBe("peer");
    expect(f.checks[0]).toMatchObject({ probes: ["read", "change", "delete", "neighbours"], neighbours: 2, change: { method: "PATCH", body: {} } });
  });

  it("lists every problem: unknown flow, sign-in flow, uncaptured value, literal secret", () => {
    const text = JSON.stringify({
      version: 1,
      flows: "flows.json",
      actors: { owner: { headers: { Authorization: "Bearer abc123" } }, other: { session: "bob" } },
      checks: [
        { flow: "nope", resource: "/x/{{id}}" },
        { flow: "signedIn", resource: "/x/{{id}}" },
        { flow: "project", resource: "/api/projects/{{id}}" },
      ],
    });
    const msg = (() => {
      try {
        parseTwoActorFile(text, flows, "actors.json");
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(msg).toContain('actors.owner: header "Authorization" holds a secret');
    expect(msg).toContain('checks[0]: no flow "nope"');
    expect(msg).toContain('checks[1]: "signedIn" is a sign-in flow');
    expect(msg).toContain('checks[2]: {{id}} is not captured by flow "project"');
  });

  it("refuses an actor with neither a session nor headers, and a resource without the id", () => {
    expect(() => parseTwoActorFile(file({ actors: { owner: {}, other: { session: "bob" } } }), flows)).toThrow(/an actor needs a session or headers/);
    expect(() => parseTwoActorFile(file({}, { resource: "/api/projects" }), flows)).toThrow(/names the created id/);
  });
});

describe("cookieHeaderFor (#233)", () => {
  const state = {
    cookies: [
      { name: "sid", value: "bob", domain: ".example.com", path: "/" },
      { name: "other", value: "x", domain: "elsewhere.com", path: "/" },
      { name: "old", value: "y", domain: "example.com", path: "/", expires: 1 },
      { name: "sec", value: "z", domain: "example.com", path: "/", secure: true },
    ],
    origins: [],
  };
  it("sends the live cookies of the base URL's host only", () => {
    expect(cookieHeaderFor(state, "http://api.example.com")).toBe("sid=bob");
    expect(cookieHeaderFor(state, "https://example.com")).toBe("sid=bob; sec=z");
    expect(cookieHeaderFor(state, "https://nothing.org")).toBeUndefined();
  });
});

describe("actorHeaders (#233)", () => {
  let sessions: string;
  beforeAll(async () => {
    sessions = await mkdtemp(join(tmpdir(), "cairn-actor-headers-"));
    await writeFile(
      join(sessions, "bob.storageState.json"),
      JSON.stringify({ cookies: [{ name: "sid", value: "bob", domain: "api.example.com", path: "/" }], origins: [] }),
    );
  });
  afterAll(async () => {
    await rm(sessions, { recursive: true, force: true });
  });
  const env = { ALICE_TOKEN: "alice-token", BOB_TOKEN: "bob-token", OTHER_KEY: "alice-key", BOB_COOKIE: "theme=dark" };
  const plan = (headers: Record<string, string>, owner: Record<string, unknown>, other: Record<string, unknown>): TwoActorPlan => ({
    file: parseTwoActorFile(JSON.stringify({ version: 1, flows: "flows.json", actors: { owner, other }, checks: [{ flow: "project", resource: "/api/projects/{{projectId}}" }] }), flows),
    flows: { ...flows, headers },
    sessionsDir: sessions,
  });
  const lower = (h: Record<string, string>): string[] => Object.keys(h).map((k) => k.toLowerCase());

  it("gives the flow file's credentials to the owner only: a session-given other actor sends its cookie and nothing of the owner", async () => {
    const p = plan({ Authorization: "Bearer {{env.ALICE_TOKEN}}", "X-Api-Key": "{{env.OTHER_KEY}}", Accept: "application/json" }, { headers: { "X-Client": "cairn" } }, { session: "bob" });
    const owner = await actorHeaders(p.file.actors.owner, p, "https://api.example.com", env);
    const other = await actorHeaders(p.file.actors.other, p, "https://api.example.com", env);
    expect(owner).toMatchObject({ Authorization: "Bearer alice-token", "X-Api-Key": "alice-key", Accept: "application/json" });
    expect(other).toEqual({ Accept: "application/json", Cookie: "sid=bob" });
    expect(JSON.stringify(other)).not.toContain("alice");
  });

  it("merges header names case-insensitively, so one name goes out with one value", async () => {
    const p = plan(
      { Authorization: "Bearer {{env.ALICE_TOKEN}}", accept: "text/plain" },
      { headers: { authorization: "Bearer {{env.ALICE_TOKEN}}", Accept: "application/json" } },
      { session: "bob", headers: { authorization: "Bearer {{env.BOB_TOKEN}}", cookie: "{{env.BOB_COOKIE}}" } },
    );
    const owner = await actorHeaders(p.file.actors.owner, p, "https://api.example.com", env);
    const other = await actorHeaders(p.file.actors.other, p, "https://api.example.com", env);
    expect(lower(owner).sort()).toEqual(["accept", "authorization"]);
    expect(Object.values(owner).sort()).toEqual(["Bearer alice-token", "application/json"]);
    expect(lower(other).sort()).toEqual(["accept", "authorization", "cookie"]);
    expect(Object.values(other)).toContain("Bearer bob-token");
    expect(Object.values(other)).toContain("sid=bob");
    expect(JSON.stringify(other)).not.toContain("alice");
  });
});
