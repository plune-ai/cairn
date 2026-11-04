import { describe, it, expect } from "vitest";
import { parseApiFlows } from "../../src/api/flows.js";
import { cookieHeaderFor, parseTwoActorFile } from "../../src/api/two-actor.js";

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
