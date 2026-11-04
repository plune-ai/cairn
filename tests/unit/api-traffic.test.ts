import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiTrafficRecorder, parseApiOrigins } from "../../src/browser/api-traffic.js";
import { DERIVED_KEY, writeDerivedSpec } from "../../src/api/derived.js";
import { ingestOpenApi } from "../../src/api/openapi.js";

/**
 * #229: the API requests a run sees are folded into an OpenAPI draft — the app's own origin only (or one allowed by
 * --api-origin), no static files, ids folded into parameters, response bodies read for their schema and not kept.
 */
const APP = "https://app.example.test";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0cmFmZmljIn0.FAKEtrafficSIG0042";

const json = (v: unknown) => () => Promise.resolve(JSON.stringify(v));

function sample(rec: ApiTrafficRecorder): void {
  const auth = { authorization: `Bearer ${JWT}`, cookie: "sid=FAKE-traffic-sid-5e6f7a" };
  rec.note({ method: "GET", url: `${APP}/`, resourceType: "document", status: 200, responseContentType: "text/html" });
  rec.note({ method: "GET", url: `${APP}/app.js`, resourceType: "script", status: 200, responseContentType: "text/javascript" });
  rec.note({ method: "GET", url: `${APP}/logo.png`, resourceType: "image", status: 200 });
  rec.note({ method: "GET", url: `${APP}/api/projects?page=1&token=FAKE-traffic-q-1a2b`, resourceType: "fetch", status: 200, requestHeaders: auth, responseContentType: "application/json", body: json([{ id: 123, name: "Alpha" }]) });
  rec.note({ method: "GET", url: `${APP}/api/projects/123`, resourceType: "fetch", status: 200, requestHeaders: auth, responseContentType: "application/json", body: json({ id: 123, name: "Alpha", secretNote: "FAKE-traffic-body-value" }) });
  rec.note({ method: "GET", url: `${APP}/api/projects/456`, resourceType: "xhr", status: 404, requestHeaders: auth, responseContentType: "application/json", body: json({ error: "missing" }) });
  rec.note({ method: "POST", url: `${APP}/api/session`, resourceType: "fetch", status: 200, requestHeaders: { "content-type": "application/json" }, postData: JSON.stringify({ email: "qa@example.test", password: "FAKE-traffic-Pa55!" }), responseContentType: "application/json", body: json({ token: "FAKE-traffic-resp-tok-77" }) });
  rec.note({ method: "POST", url: "https://analytics.example-tracker.test/collect", resourceType: "fetch", status: 204 });
  rec.note({ method: "GET", url: "https://api.example.test/v1/flags", resourceType: "fetch", status: 200, responseContentType: "application/json", body: json({ on: true }) });
}

describe("ApiTrafficRecorder (#229)", () => {
  it("keeps the app's own API requests, folds ids, and leaves static files and other origins out", async () => {
    const rec = new ApiTrafficRecorder({ origins: [APP] });
    sample(rec);
    await rec.flush();
    expect(rec.recorded).toBe(4);
    expect(rec.leftOut).toEqual({ static: 3, otherOrigin: 2 });
    const { doc } = rec.spec({ title: "app" });
    expect(Object.keys((doc as { paths: object }).paths).sort()).toEqual(["/api/projects", "/api/projects/{id}", "/api/session"]);
    expect((doc as { servers: unknown }).servers).toEqual([{ url: APP }]);
    const op = (doc as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths["/api/projects/{id}"]!.get!;
    expect(op[DERIVED_KEY]).toBe(true);
    expect(Object.keys(op.responses as object)).toEqual(["200", "404"]);
  });

  it("an origin allowed explicitly is kept as well", async () => {
    const rec = new ApiTrafficRecorder({ origins: [APP, "https://api.example.test"] });
    sample(rec);
    await rec.flush();
    expect(rec.leftOut.otherOrigin).toBe(1);
    expect(Object.keys((rec.spec({ title: "app" }).doc as { paths: object }).paths)).toContain("/v1/flags");
  });

  it("the file it gives is read by ingestOpenApi and holds no token, cookie or body value", async () => {
    const rec = new ApiTrafficRecorder({ origins: [APP] });
    sample(rec);
    await rec.flush();
    const { doc, secrets } = rec.spec({ title: "app" });
    const dir = await mkdtemp(join(tmpdir(), "cairn-traffic-"));
    try {
      const file = await writeDerivedSpec(dir, doc, secrets);
      const model = await ingestOpenApi(file);
      expect(model.endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
        "GET /api/projects",
        "GET /api/projects/{id}",
        "POST /api/session",
      ]);
      const saved = await readFile(file, "utf8");
      for (const t of [JWT, "FAKEtrafficSIG0042", "FAKE-traffic-sid-5e6f7a", "FAKE-traffic-q-1a2b", "FAKE-traffic-Pa55!", "FAKE-traffic-resp-tok-77", "FAKE-traffic-body-value", "analytics.example-tracker"]) {
        expect(saved, t).not.toContain(t);
      }
      expect(secrets).toEqual(expect.arrayContaining([JWT, "FAKE-traffic-sid-5e6f7a", "FAKE-traffic-q-1a2b", "FAKE-traffic-Pa55!", "FAKE-traffic-resp-tok-77"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not read a body that is not JSON or is too large", async () => {
    const rec = new ApiTrafficRecorder({ origins: [APP], maxBodyBytes: 100 });
    let reads = 0;
    const body = (): Promise<string> => {
      reads += 1;
      return Promise.resolve("{}");
    };
    rec.note({ method: "GET", url: `${APP}/api/a`, resourceType: "fetch", status: 200, responseContentType: "text/plain", body });
    rec.note({ method: "GET", url: `${APP}/api/b`, resourceType: "fetch", status: 200, responseContentType: "application/json", responseSize: 5000, body });
    rec.note({ method: "GET", url: `${APP}/api/c`, resourceType: "fetch", status: 200, responseContentType: "application/json", body });
    await rec.flush();
    expect(reads).toBe(1);
    expect(rec.recorded).toBe(3);
  });

  it("parseApiOrigins takes the run's origin and the ones given, and refuses what is not an http(s) origin", () => {
    expect(parseApiOrigins("https://app.example.test/login?x=1")).toEqual(["https://app.example.test"]);
    expect(parseApiOrigins("https://app.example.test/", "https://api.example.test, http://localhost:8080/")).toEqual([
      "https://app.example.test",
      "https://api.example.test",
      "http://localhost:8080",
    ]);
    expect(() => parseApiOrigins("https://app.example.test/", "ftp://x.test")).toThrow(/--api-origin/);
    expect(() => parseApiOrigins("https://app.example.test/", "not a url")).toThrow(/--api-origin/);
  });
});
