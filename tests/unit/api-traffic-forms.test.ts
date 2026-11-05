import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { ApiTrafficRecorder, parseApiOrigins, writeTrafficSpec, type SeenExchange } from "../../src/browser/api-traffic.js";
import { deriveSpec } from "../../src/api/collection.js";
import { generateApiCases } from "../../src/api/cases.js";
import { DERIVED_SPEC_FILE, writeDerivedSpec } from "../../src/api/derived.js";
import { ingestOpenApi } from "../../src/api/openapi.js";

/**
 * #229: whatever the traffic says, openapi.derived.json holds a string that came from the traffic only when that
 * string has passed a fixed form that a free-text value cannot have. Everything goes through the recorder and the
 * writer the run uses, and every check reads the file.
 */
const APP = "https://acme-tenant.app.example.test:8443";
const J = "application/json";
const FORM = "application/x-www-form-urlencoded";

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: Schema;
  items?: Schema;
}
interface Operation {
  parameters?: { name: string; in: string }[];
  requestBody?: { content: Record<string, { schema?: Schema }> };
  responses: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}
interface Doc {
  openapi: string;
  info: { title: string };
  servers?: unknown;
  paths: Record<string, Record<string, Operation>>;
}

type Feed = (r: ApiTrafficRecorder) => void;
const get = (r: ApiTrafficRecorder, path: string, extra: Partial<SeenExchange> = {}): void =>
  r.note({ method: "GET", url: `${APP}${path}`, resourceType: "fetch", status: 200, ...extra });
const post = (r: ApiTrafficRecorder, path: string, contentType: string, body: string, extra: Partial<SeenExchange> = {}): void =>
  r.note({ method: "POST", url: `${APP}${path}`, resourceType: "fetch", status: 200, requestHeaders: { "content-type": contentType }, postData: body, ...extra });
const answer = (v: unknown): Partial<SeenExchange> => ({ responseContentType: J, body: () => Promise.resolve(JSON.stringify(v)) });

/** The file a run with this traffic leaves, read back; what `ingestOpenApi` said of it; and the run log's lines. */
async function draft(feed: Feed, runSecrets: string[] = []): Promise<{ saved: string; doc: Doc; ingested: string; log: string[] }> {
  const rec = new ApiTrafficRecorder({ origins: [APP] });
  feed(rec);
  const dir = await mkdtemp(join(tmpdir(), "cairn-forms-"));
  const log: string[] = [];
  try {
    await writeTrafficSpec(rec, dir, APP, runSecrets, (e) => log.push(e));
    const file = join(dir, DERIVED_SPEC_FILE);
    const saved = await readFile(file, "utf8");
    const ingested = await ingestOpenApi(file).then(
      () => "ok",
      (e: Error) => e.message,
    );
    return { saved, doc: JSON.parse(saved) as Doc, ingested, log };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const paths = (d: { doc: Doc }): string[] => Object.keys(d.doc.paths).sort();
const responseSchema = (d: { doc: Doc }, path: string): Schema => d.doc.paths[path]!.get!.responses["200"]!.content![J]!.schema!;
const requestSchema = (d: { doc: Doc }, path: string, media = J): Schema => d.doc.paths[path]!.post!.requestBody!.content[media]!.schema!;

/** [what, the traffic, the strings the file must not hold, the run's secrets]. */
const NEVER_IN_THE_FILE: [string, Feed, string[], string[]?][] = [
  // B1: a text or JSON body sent as a form, and a query part with no `=`, have no names.
  ["B1 JSON body sent as a form", (r) => post(r, "/api/submit", FORM, JSON.stringify({ name: "Alice Smith", diagnosis: "private note" })), ["Alice Smith", "private note", "diagnosis"]],
  ["B1 text sent as a form", (r) => post(r, "/api/submit", FORM, "this is my private message to Bob"), ["this is my private message to Bob", "private"]],
  ["B1 JSON with a password sent as a form", (r) => post(r, "/api/submit", FORM, JSON.stringify({ login: "alice", password: "x" })), ["alice", "login", "password"]],
  ["B1 bare query", (r) => get(r, "/api/lookup?Alice%20Smith"), ["Alice Smith", "Alice%20Smith"]],
  ["B1 JSON as a query", (r) => get(r, '/api/lookup?{"note":"private"}'), ["private", "note"]],
  ["B1 one bare word as a query", (r) => get(r, "/api/lookup?alice"), ["alice"]],
  ["B1 one bare word as a form", (r) => post(r, "/api/submit", FORM, "alice"), ["alice"]],

  // B2: a word in a path.
  ["B2 Cyrillic name", (r) => get(r, "/api/x/Леонід"), ["Леонід", encodeURIComponent("Леонід")]],
  ["B2 phone", (r) => get(r, "/api/x/+380441234567"), ["380441234567"]],
  ["B2 invite token", (r) => get(r, "/api/x/x7f-9kq-2mz"), ["x7f-9kq-2mz"]],
  ["B2 letters-only token", (r) => get(r, "/api/x/kdjfhgkdjfhgkdjf"), ["kdjfhgkdjfhgkdjf"]],
  ["B2 short mixed id", (r) => get(r, "/api/x/a1b2c3d"), ["a1b2c3d"]],
  ["B2 hex without digits", (r) => get(r, "/api/x/deadbeef"), ["deadbeef"]],
  ["B2 file name", (r) => get(r, "/api/x/john_doe_passport.pdf"), ["john_doe_passport", "passport"]],
  ["B2 e-mail without a dot", (r) => get(r, "/api/x/alice@corp"), ["alice"]],
  ["B2 e-mail on a Cyrillic domain", (r) => get(r, "/api/x/олена@пошта.укр"), ["олена", encodeURIComponent("олена")]],
  ["B2 a word longer than 32 characters", (r) => get(r, "/api/x/averyveryveryveryveryverylongwordinapath"), ["averyveryvery"]],
  ["B2 a credential-shaped word that ends in digits", (r) => get(r, "/api/x/resettoken12345678"), ["resettoken12345678"]],
  ["B2 a word that reads as :name", (r) => get(r, "/api/x/:alicesmith/y"), ["alicesmith"]],
  ["B2 a word that reads as {name}", (r) => get(r, "/api/x/%7Balicesmith%7D/y"), ["alicesmith"]],
  [
    "B2 people in the same place of a path",
    (r) => {
      for (const who of ["alice", "bob", "carol", "jane-roe", "john-doe"]) get(r, `/api/users/${who}/profile`);
    },
    ["alice", "bob", "carol", "jane-roe", "john-doe"],
  ],
  [
    "B2 a slug a response names, the response after the path",
    (r) => {
      get(r, "/api/tenants/john-doe");
      get(r, "/api/lookup", answer({ slug: "john-doe" }));
    },
    ["john-doe"],
  ],

  // B3: a key of a JSON object.
  ["B3 person as a key", (r) => get(r, "/api/a", answer({ "Alice Smith": { role: "admin" } })), ["Alice Smith"]],
  ["B3 phone as a key", (r) => get(r, "/api/a", answer({ "+380441234567": 1 })), ["380441234567"]],
  ["B3 address as a key", (r) => get(r, "/api/a", answer({ "10.0.0.17": 1 })), ["10.0.0.17"]],
  ["B3 a client's domain as a key", (r) => get(r, "/api/a", answer({ "customer-bank.example": 1 })), ["customer-bank"]],
  ["B3 numeric id as a key", (r) => get(r, "/api/a", answer({ 1234567: { a: 1 } })), ["1234567"]],
  ["B3 date as a key", (r) => get(r, "/api/a", answer({ "2026-11-05": 3 })), ["2026-11-05"]],
  ["B3 text as a key in a request", (r) => post(r, "/api/a", J, JSON.stringify({ "private note text": 1 })), ["private note text"]],

  // Names: a query name or a form field has the same form as a key.
  ["query name that is a person", (r) => get(r, "/api/a?Alice%20Smith=1"), ["Alice Smith", "Alice%20Smith"]],
  ["query name that is an e-mail address", (r) => get(r, "/api/a?bob@example.com=1"), ["bob@example.com"]],
  ["query name with brackets", (r) => get(r, "/api/a?filter[alice]=1"), ["alice"]],
  ["form field that is a person", (r) => post(r, "/api/submit", FORM, "Alice%20Smith=1"), ["Alice Smith", "Alice%20Smith"]],
  ["run secret as a query name", (r) => get(r, "/api/a?opensesame=1"), ["opensesame"], ["opensesame"]],
  ["run secret as a key", (r) => get(r, "/api/a", answer({ opensesame: 1, id: 2 })), ["opensesame"], ["opensesame"]],
  ["run secret as a form field", (r) => post(r, "/api/submit", FORM, "opensesame=1&page=2"), ["opensesame"], ["opensesame"]],
  ["a cookie's value as a key", (r) => get(r, "/api/a", { requestHeaders: { cookie: "sess=plainsessionword" }, ...answer({ plainsessionword: 1, id: 2 }) }), ["plainsessionword"]],

  // Rule 4: a word equal to a value seen anywhere.
  ["a header's value in a path", (r) => get(r, "/api/tenants/acme-corp", { requestHeaders: { "x-tenant": "acme-corp" } }), ["acme-corp"]],
  ["a cookie's value in a path", (r) => get(r, "/api/sess/plainsessionword", { requestHeaders: { cookie: "sess=plainsessionword; theme=dark" } }), ["plainsessionword"]],
  ["a bearer credential in a path", (r) => get(r, "/api/k/plainbearerword", { requestHeaders: { authorization: "Bearer plainbearerword" } }), ["plainbearerword"]],
  ["a form value in a path", (r) => { post(r, "/api/submit", FORM, "slug=jane-roe"); get(r, "/api/u/jane-roe"); }, ["jane-roe"]],
  ["a query value in a path", (r) => get(r, "/api/u/jane-roe?who=jane-roe"), ["jane-roe"]],
  ["a bare query in a path", (r) => get(r, "/api/u/jane-roe?jane-roe"), ["jane-roe"]],
  ["a request body's value in a path", (r) => { post(r, "/api/submit", J, JSON.stringify({ deep: { er: ["jane-roe"] } })); get(r, "/api/u/jane-roe"); }, ["jane-roe"]],
  ["a value past the 50th item of an array", (r) => { get(r, "/api/list", answer({ all: [...Array.from({ length: 60 }, (_, i) => `v${i}`), "jane-roe"] })); get(r, "/api/u/jane-roe"); }, ["jane-roe"]],
  ["a word encoded in the path", (r) => { get(r, "/api/u/jane%2Droe"); get(r, "/api/lookup", answer({ slug: "jane-roe" })); }, ["jane-roe", "jane%2Droe"]],
  ["a word in another case", (r) => { get(r, "/api/u/Jane-Roe"); get(r, "/api/lookup", answer({ slug: "jane-roe" })); }, ["jane-roe", "Jane-Roe"]],
  ["a query value on another origin", (r) => { r.note({ method: "GET", url: "https://tracker.example.test/c?uid=jane-roe", resourceType: "fetch", status: 200 }); get(r, "/api/u/jane-roe"); }, ["jane-roe", "tracker"]],
  ["a run secret in a path", (r) => get(r, "/api/vault/opensesame"), ["opensesame"], ["opensesame"]],
  ["a run secret in another case", (r) => get(r, "/api/Opensesame"), ["pensesame"], ["opensesame"]],
  [
    "M3 a value seen after 5050 others",
    (r) => {
      for (let n = 0; n < 101; n++) {
        const ids = Array.from({ length: 50 }, (_, i) => `3f2b9c1e-9a7d-4c11-8b2e-${String(n).padStart(6, "0")}${String(i).padStart(6, "0")}`);
        get(r, "/api/list", answer({ ids }));
      }
      get(r, "/api/vault/opensesame", answer({ password: "opensesame" }));
    },
    ["opensesame"],
  ],

  // Rule 5: a parameter's name.
  ["M1 a run secret names no parameter", (r) => get(r, "/api/opensesame/5/parts/6"), ["opensesame"], ["opensesame"]],
  ["M1 a known slug names no parameter", (r) => { get(r, "/api/john-doe/5/parts/6"); get(r, "/api/lookup", answer({ slug: "john-doe" })); }, ["john-doe", "johnDoe"]],
  ["M1 a dashed run secret names no parameter", (r) => get(r, "/api/open-sesame/5/parts/6"), ["open-sesame", "openSesame"], ["open-sesame"]],

  // Rule 6: a media type.
  ["M8 a tenant in a request's media type", (r) => post(r, "/api/a", "application/vnd.tenant.acme-corp.v2+json", "{}"), ["acme-corp"]],
  ["M8 an e-mail address as a media type", (r) => post(r, "/api/a", "alice@example.com", "{}"), ["alice@example.com"]],
  ["M8 a customer in a response's media type", (r) => get(r, "/api/a", { responseContentType: "application/vnd.customer-77.bank+json", body: () => Promise.resolve("{}") }), ["customer-77"]],

  // Rule 7: the host and the port.
  ["M7 the host and the port", (r) => get(r, "/api/a"), ["acme-tenant", "8443", "app.example.test"]],
];

describe("what the traffic says stays out of the file (#229)", () => {
  it.each(NEVER_IN_THE_FILE)("%s", async (_what, feed, absent, runSecrets) => {
    const d = await draft(feed, runSecrets);
    for (const a of absent) expect(d.saved, a).not.toContain(a);
    expect(d.saved).not.toContain("‹redacted›");
    expect(d.ingested).toBe("ok");
  });

  it("a name that fails the form is dropped alone: the object keeps its other properties", async () => {
    const d = await draft((r) => get(r, "/api/a", answer({ id: 1, title: "x", "Alice Smith": 2 })));
    expect(responseSchema(d, "/api/a").properties).toEqual({ id: { type: "integer" }, title: { type: "string" } });
    expect(responseSchema(d, "/api/a").required).toEqual(["id", "title"]);
  });

  it("a name with a dot is dropped alone, and so is one of a query", async () => {
    const d = await draft((r) => get(r, "/api/a?filter.status=open&page=2", answer({ id: 1, "user.name": "x" })));
    expect(Object.keys(responseSchema(d, "/api/a").properties!)).toEqual(["id"]);
    expect(d.doc.paths["/api/a"]!.get!.parameters!.map((p) => p.name)).toEqual(["page"]);
  });

  it("an object most of whose keys fail the form is a map, with the values' schema and no key", async () => {
    const d = await draft((r) => get(r, "/api/a", answer({ "Alice Smith": { role: "admin" }, "Bob Jones": { role: "viewer" }, ok: { role: "x" } })));
    const s = responseSchema(d, "/api/a");
    expect(s.properties).toBeUndefined();
    expect(s.additionalProperties).toMatchObject({ type: "object", properties: { role: { type: "string" } } });
  });

  it("an object with many keys of one shape is a map, and so is one whose keys pile up over the run", async () => {
    const d = await draft((r) => {
      const many: Record<string, number> = {};
      for (let k = 0; k < 30; k++) many[`user_${k}`] = 1;
      get(r, "/api/shape", answer(many));
      for (let i = 0; i < 300; i++) {
        const o: Record<string, { a: number }> = {};
        for (let k = 0; k < 200; k++) o[`item_${i}_${k}`] = { a: 1 };
        get(r, "/api/feed", answer(o));
      }
      const words = "ab cd ef gh ij kl mn op qr st uv wx yz".split(" ");
      for (const a of words) for (const b of words) get(r, "/api/words", answer({ [`${a}x${b}`]: 1, [`${b}y${a}`]: 1 }));
    });
    for (const p of ["/api/shape", "/api/feed", "/api/words"]) {
      expect(responseSchema(d, p).properties, p).toBeUndefined();
      expect(responseSchema(d, p).additionalProperties, p).toBeDefined();
    }
    expect(d.saved.length).toBeLessThan(100_000);
  });
});

describe("what must stay stays (#229)", () => {
  it("the words of an API, and paths that differ only at their end", async () => {
    const d = await draft((r) => {
      for (const p of ["/api/users", "/api/projects", "/api/projects/123", "/api/projects/456", "/api/settings", "/api/v1/me", "/api/oauth2/token", "/api/s3/buckets", "/api/users/me/profile", "/api/users/you/profile"]) get(r, p);
    });
    expect(paths(d)).toEqual(
      ["/api/oauth2/token", "/api/projects", "/api/projects/{id}", "/api/s3/buckets", "/api/settings", "/api/users", "/api/users/me/profile", "/api/users/you/profile", "/api/v1/me"].sort(),
    );
  });

  it("people in the same place of a path fold into one operation, across methods", async () => {
    const d = await draft((r) => {
      for (const who of ["alice", "bob"]) get(r, `/api/users/${who}/profile`);
      r.note({ method: "PUT", url: `${APP}/api/users/carol/profile`, resourceType: "fetch", status: 204 });
    });
    expect(paths(d)).toEqual(["/api/users/{id}/profile"]);
    expect(Object.keys(d.doc.paths["/api/users/{id}/profile"]!).sort()).toEqual(expect.arrayContaining(["get", "put"]));
  });

  const M6 = ["address1", "addressLine1", "password1", "base64data", "oauth2token", "ipv4address", "sha256sum", "s3bucket", "phoneNumber2", "name", "email", "age"];
  const m6Body = Object.fromEntries(M6.map((k) => [k, "string"]));

  it("M6 ordinary names stay names, in a request and in a response", async () => {
    const d = await draft((r) => {
      post(r, "/api/customers", J, JSON.stringify(m6Body));
      get(r, "/api/customers", answer(m6Body));
    });
    expect(Object.keys(requestSchema(d, "/api/customers").properties ?? {})).toEqual(M6);
    expect(Object.keys(responseSchema(d, "/api/customers").properties ?? {})).toEqual(M6);
  });

  it("M6 one token-like key does not turn the object into a map, and the happy-path body keeps its fields", async () => {
    const d = await draft((r) => post(r, "/api/customers", J, JSON.stringify({ name: "string", email: "string", age: 0, addressLine1: "x", FAKEtok3n4b5c6d7: 1 })));
    expect(Object.keys(requestSchema(d, "/api/customers").properties ?? {})).toEqual(["name", "email", "age", "addressLine1"]);
    const dir = await mkdtemp(join(tmpdir(), "cairn-forms-"));
    try {
      const file = await writeDerivedSpec(dir, d.doc as unknown as Record<string, unknown>, []);
      const c = generateApiCases(await ingestOpenApi(file))[0]!;
      expect(c.body).toMatchObject({ name: expect.any(String) as unknown, email: expect.any(String) as unknown, age: expect.any(Number) as unknown });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a value of the traffic does not take a property away: names are checked against secrets only", async () => {
    const d = await draft((r) => {
      get(r, "/api/projects?page=1&sort=name", answer([{ id: 1, name: "Alpha" }]));
      post(r, "/api/projects", J, JSON.stringify({ name: "Gamma", public: false }));
      get(r, "/api/columns", answer({ column: "email", email: "x", passwordPolicy: "phone", phone: "y" }));
    });
    expect(Object.keys(requestSchema(d, "/api/projects").properties ?? {})).toEqual(["name", "public"]);
    expect(responseSchema(d, "/api/projects").items!.properties).toHaveProperty("name");
    expect(Object.keys(responseSchema(d, "/api/columns").properties ?? {})).toEqual(["column", "email", "passwordPolicy", "phone"]);
  });

  it("a one-off word in a path stays: no form tells it from a word of the API", async () => {
    expect(paths(await draft((r) => get(r, "/api/tenants/acme-corp")))).toEqual(["/api/tenants/acme-corp"]);
  });
});

describe("parameter names (#229)", () => {
  it("come from a word that stayed in the path; otherwise {id}, numbered", async () => {
    expect(paths(await draft((r) => get(r, "/api/projects/5/tasks/6")))).toEqual(["/api/projects/{projectId}/tasks/{taskId}"]);
    expect(paths(await draft((r) => get(r, "/api/opensesame/5/parts/6"), ["opensesame"]))).toEqual(["/api/{apiId}/{id}/parts/{partId}"]);
    expect(paths(await draft((r) => get(r, "/5/6")))).toEqual(["/{id}/{id2}"]);
    expect(paths(await draft((r) => get(r, "/api/x/:alicesmith/y")))).toEqual(["/api/x/{id}/y"]);
  });
});

describe("media types (#229)", () => {
  it("are written from a fixed set: a +json suffix is application/json, anything else is not written", async () => {
    const d = await draft((r) => {
      post(r, "/api/a", "application/vnd.tenant.acme-corp.v2+json; charset=utf-8", '{"id":1}');
      post(r, "/api/b", "alice@example.com", '{"id":1}');
      post(r, "/api/c", "multipart/form-data; boundary=----X", "------X--");
      post(r, "/api/d", "text/plain", "hello");
      get(r, "/api/e", { responseContentType: "application/problem+json", body: () => Promise.resolve('{"id":1}') });
    });
    expect(Object.keys(d.doc.paths["/api/a"]!.post!.requestBody!.content)).toEqual([J]);
    expect(d.doc.paths["/api/b"]!.post!.requestBody).toBeUndefined();
    expect(Object.keys(d.doc.paths["/api/c"]!.post!.requestBody!.content)).toEqual(["multipart/form-data"]);
    expect(Object.keys(d.doc.paths["/api/d"]!.post!.requestBody!.content)).toEqual(["text/plain"]);
    expect(Object.keys(d.doc.paths["/api/e"]!.get!.responses["200"]!.content!)).toEqual([J]);
  });
});

describe("the host (#229)", () => {
  it("is not in the file: the title is generic and there is no servers", async () => {
    const d = await draft((r) => get(r, "/api/a"));
    expect(d.doc.servers).toBeUndefined();
    expect(d.doc.info.title).toBe("API draft (from the UI traffic)");
  });
});

describe("the document stays whole (#229): no text pass over it", () => {
  it("a sensitive-named field's value does not touch a path or the host", async () => {
    const a = await draft((r) => get(r, "/api/csrf", answer({ csrfTokenUrl: "/api/csrf" })));
    expect(paths(a)).toEqual(["/api/csrf"]);
    const b = await draft((r) => get(r, "/api/config", answer({ cookieDomain: "acme-tenant.app.example.test" })));
    expect(b.saved).not.toContain("‹redacted›");
  });

  it("a password of the environment makes a word of the path a parameter, not a hole in it", async () => {
    expect(paths(await draft((r) => get(r, "/api/admin/users"), ["admin"]))).toEqual(["/api/{id}/users"]);
  });

  it("a secret equal to the OpenAPI version leaves the document readable", async () => {
    const d = await draft((r) => get(r, "/api/config", answer({ secretVersion: "3.0.3" })));
    expect(d.doc.openapi).toBe("3.0.3");
    expect(d.ingested).toBe("ok");
  });

  it("500 operations and 3380 secrets are written in a moment", { timeout: 280_000 }, async () => {
    const L = "gklmnprstv";
    const secrets = Array.from({ length: 3380 }, (_, i) => `plainsecretword${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i >> 5) % 26))}${String.fromCharCode(97 + ((i >> 10) % 26))}`);
    const t0 = performance.now();
    const d = await draft((r) => {
      for (let i = 0; i < 500; i++) get(r, `/api/ro${L[i % 10]}o${L[Math.floor(i / 10) % 10]}o${L[Math.floor(i / 100) % 10]}`, answer({ id: 1, name: "a", nested: { a: 1, b: "x", c: [1] } }));
    }, secrets);
    expect(paths(d).length).toBe(500);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe("a long value does not stop the run (M5)", () => {
  const blob = "a".repeat(200_000);
  const LIMIT = 2_000;

  it("a blob sent as a form", { timeout: 120_000 }, async () => {
    const t0 = performance.now();
    await draft((r) => post(r, "/api/up", FORM, blob));
    expect(performance.now() - t0).toBeLessThan(LIMIT);
  });

  it("a blob as a query name", { timeout: 120_000 }, async () => {
    const t0 = performance.now();
    await draft((r) => get(r, `/api/up?${blob}=1`));
    expect(performance.now() - t0).toBeLessThan(LIMIT);
  });

  it("a blob as a word of a path", { timeout: 120_000 }, async () => {
    const t0 = performance.now();
    await draft((r) => {
      get(r, `/api/${blob}`);
      get(r, "/api/ok");
    });
    expect(performance.now() - t0).toBeLessThan(LIMIT);
  });

  it("a blob as a key of a response", { timeout: 120_000 }, async () => {
    const t0 = performance.now();
    await draft((r) => get(r, "/api/up", answer({ [blob]: 1 })));
    expect(performance.now() - t0).toBeLessThan(LIMIT);
  });

  it("a HAR with a blob sent as a form", { timeout: 120_000 }, () => {
    const har = JSON.stringify({
      log: { entries: [{ _resourceType: "xhr", request: { method: "POST", url: `${APP}/api/up`, headers: [], queryString: [], cookies: [], postData: { mimeType: FORM, text: blob } }, response: { status: 200, headers: [], cookies: [], content: { mimeType: J, text: "{}" } } }] },
    });
    const t0 = performance.now();
    expect(deriveSpec(har)).toBeDefined();
    expect(performance.now() - t0).toBeLessThan(LIMIT);
  });

  it("a request body over the limit is not parsed", async () => {
    const rec = new ApiTrafficRecorder({ origins: [APP], maxBodyBytes: 100 });
    post(rec, "/api/up", J, JSON.stringify({ big: "x".repeat(500) }));
    await rec.flush();
    const dir = await mkdtemp(join(tmpdir(), "cairn-forms-"));
    try {
      await writeTrafficSpec(rec, dir, APP, [], () => undefined);
      const saved = JSON.parse(await readFile(join(dir, DERIVED_SPEC_FILE), "utf8")) as Doc;
      expect(saved.paths["/api/up"]!.post!.requestBody!.content[J]).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the same forms for a HAR and a Postman collection (#228, #229)", () => {
  const entry = (method: string, url: string, postData: unknown, res: unknown): unknown => ({
    _resourceType: "xhr",
    request: { method, url: `https://app.example.test${url}`, headers: [], queryString: [], cookies: [], ...(postData ? { postData } : {}) },
    response: { status: 200, headers: [], cookies: [], content: { mimeType: J, text: JSON.stringify(res) } },
  });

  it("a HAR: a body sent as a form, a bare query, words of a path, keys", async () => {
    const har = JSON.stringify({
      log: {
        entries: [
          entry("POST", "/api/submit", { mimeType: FORM, text: JSON.stringify({ login: "alice", diagnosis: "private note" }) }, {}),
          entry("GET", "/api/lookup?Alice%20Smith", null, {}),
          entry("GET", "/api/x/x7f-9kq-2mz", null, { "Bob Jones": 1, "customer-bank.example": 2, id: 3 }),
          entry("GET", "/api/x/:carolsmith/y", null, {}),
          entry("GET", "/api/u/jane-roe?who=jane-roe", null, {}),
        ],
      },
    });
    const derived = deriveSpec(har)!;
    const dir = await mkdtemp(join(tmpdir(), "cairn-forms-"));
    try {
      const saved = await readFile(await writeDerivedSpec(dir, derived.doc, derived.secrets), "utf8");
      for (const a of ["alice", "diagnosis", "Alice Smith", "x7f-9kq-2mz", "Bob Jones", "customer-bank", "carolsmith", "jane-roe"]) expect(saved, a).not.toContain(a);
      await ingestOpenApi(join(dir, DERIVED_SPEC_FILE));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a run's secret reaches the HAR's document too: the word is a parameter from the start", () => {
    const har = JSON.stringify({ log: { entries: [entry("GET", "/api/vault/opensesame", null, { opensesame: 1, id: 2 })] } });
    const doc = deriveSpec(har, ["opensesame"])!.doc;
    expect(JSON.stringify(doc)).not.toContain("opensesame");
  });

  it("free text of a collection is dropped whole when it holds a secret: a summary, a tag, the title", async () => {
    const collection = {
      info: { name: "Team FAKE-tok-9z8y7x", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [{ name: "Folder FAKE-tok-9z8y7x", item: [{ name: "Login with FAKE-tok-9z8y7x", request: { method: "GET", url: "https://app.example.test/api/users" } }, { name: "List", request: { method: "GET", url: "https://app.example.test/api/teams" } }] }],
    };
    const derived = deriveSpec(JSON.stringify(collection))!;
    const dir = await mkdtemp(join(tmpdir(), "cairn-forms-"));
    try {
      const saved = await readFile(await writeDerivedSpec(dir, derived.doc, ["FAKE-tok-9z8y7x"]), "utf8");
      expect(saved).not.toContain("FAKE-tok-9z8y7x");
      expect(saved).not.toContain("‹redacted›");
      const doc = JSON.parse(saved) as { info: { title: string }; paths: Record<string, { get: { summary?: string; tags?: string[] } }> };
      expect(doc.info.title).toBe("API draft");
      expect(doc.paths["/api/users"]!.get.summary).toBeUndefined();
      expect(doc.paths["/api/teams"]!.get.summary).toBe("List");
      expect(doc.paths["/api/teams"]!.get.tags).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the recorder's own limits and failures (#229)", () => {
  const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-forms-"));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const exists = (p: string): Promise<boolean> =>
    stat(p).then(
      () => true,
      () => false,
    );

  it("hitting the limit of known values fails closed: no file, and the log says why", async () => {
    await withDir(async (dir) => {
      const rec = new ApiTrafficRecorder({ origins: [APP], maxKnownValues: 3 });
      get(rec, "/api/a", answer({ a: "one", b: "two", c: "three", d: "four", e: "five" }));
      const log: string[] = [];
      await writeTrafficSpec(rec, dir, APP, [], (e) => log.push(e));
      expect(await exists(join(dir, DERIVED_SPEC_FILE))).toBe(false);
      expect(log.join("\n")).toMatch(/too many distinct values/);
    });
  });

  it("a value's size does not count: long values are not held", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const rec = new ApiTrafficRecorder({ origins: [APP] });
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 60; i++) {
      get(rec, `/api/thumb/${i}`, answer({ thumbnail: `${i}aB`.repeat(300_000).slice(0, 900_000) }));
      await rec.flush(60_000);
    }
    gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(10_000_000);
    expect(rec.recorded).toBe(60);
  });

  it("a failed write does not stop the run: the reason goes to the log", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, DERIVED_SPEC_FILE));
      const rec = new ApiTrafficRecorder({ origins: [APP] });
      get(rec, "/api/a");
      const log: string[] = [];
      await writeTrafficSpec(rec, dir, APP, [], (e) => log.push(e));
      expect(log.join("\n")).toMatch(/could not write openapi\.derived\.json \(EISDIR\)/);
    });
  });

  it("requests that make no operation give no empty file, and the log says so", async () => {
    await withDir(async (dir) => {
      const rec = new ApiTrafficRecorder({ origins: [APP] });
      rec.note({ method: "PROPFIND", url: `${APP}/api/dav`, resourceType: "fetch", status: 207 });
      const log: string[] = [];
      await writeTrafficSpec(rec, dir, APP, [], (e) => log.push(e));
      expect(await exists(join(dir, DERIVED_SPEC_FILE))).toBe(false);
      expect(log.join("\n")).toMatch(/1 API request\(s\) made no operation, no openapi\.derived\.json/);
    });
  });

  it("the log names up to three refused origins, with counts", async () => {
    await withDir(async (dir) => {
      const rec = new ApiTrafficRecorder({ origins: [APP] });
      get(rec, "/api/a");
      for (const [o, n] of [["https://www.example.test", 3], ["https://a.example.test", 2], ["https://b.example.test", 4], ["https://c.example.test", 1]] as const) {
        for (let i = 0; i < n; i++) rec.note({ method: "GET", url: `${o}/api/x`, resourceType: "fetch", status: 200 });
      }
      const log: string[] = [];
      await writeTrafficSpec(rec, dir, APP, [], (e) => log.push(e));
      const line = log.join("\n");
      expect(line).toContain("10 to other origins: https://b.example.test (4), https://www.example.test (3), https://a.example.test (2) (allow one with --api-origin)");
      expect(line).not.toContain("https://c.example.test");
    });
  });

  it("a late answer after the cut changes nothing", async () => {
    let late: (s: string) => void = () => undefined;
    const rec = new ApiTrafficRecorder({ origins: [APP] });
    get(rec, "/api/late", { responseContentType: J, body: () => new Promise<string>((res) => (late = res)) });
    await rec.flush(20);
    late(JSON.stringify({ tooLate: 1 }));
    await new Promise((res) => setTimeout(res, 20));
    await withDir(async (dir) => {
      await writeTrafficSpec(rec, dir, APP, [], () => undefined);
      expect(await readFile(join(dir, DERIVED_SPEC_FILE), "utf8")).not.toContain("tooLate");
    });
  });

  it("an answer longer than the limit with no content-length gives no schema", async () => {
    const rec = new ApiTrafficRecorder({ origins: [APP], maxBodyBytes: 100 });
    get(rec, "/api/long", answer({ longAnswer: "x".repeat(500) }));
    await withDir(async (dir) => {
      await writeTrafficSpec(rec, dir, APP, [], () => undefined);
      expect(await readFile(join(dir, DERIVED_SPEC_FILE), "utf8")).not.toContain("longAnswer");
    });
  });

  it("the values of a request whose answer is cut off are still known", async () => {
    const d = await draft((r) => {
      post(r, "/api/watch?who=jane-roe", FORM, "slug=john-doe", { responseContentType: J, body: () => new Promise<string>(() => undefined) });
      get(r, "/api/u/jane-roe");
      get(r, "/api/v/john-doe");
    });
    expect(paths(d)).toEqual(["/api/u/{id}", "/api/v/{id}", "/api/watch"]);
  });
});

describe("--api-origin refusals (#229)", () => {
  it.each(["https://*.example.com", "*", "https://api.example.com/*", "https://api.example.com/x?y=*", "https://user:pw12345@api.example.com", "ftp://user:pw12345@x.test", "user:pw12345@x.test"])(
    "%s is refused, and the refusal prints no password",
    (raw) => {
      let message = "";
      try {
        parseApiOrigins("https://app.example.test/", raw);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/--api-origin/);
      expect(message).not.toContain("pw12345");
    },
  );

  it("a --url that is no URL is left to the run's own failure", () => {
    expect(parseApiOrigins("example.com")).toEqual([]);
  });
});
