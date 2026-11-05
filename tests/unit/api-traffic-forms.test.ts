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
 * string has passed a fixed form. Everything goes through the recorder and the writer the run uses, and every check
 * reads the file.
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
  summary?: string;
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

const har = (...entries: unknown[]): unknown => ({ log: { entries } });
const harGet = (url: string, res: unknown = {}, request: object = {}): unknown => ({
  _resourceType: "xhr",
  request: { method: "GET", url: url.startsWith("/") ? `https://app.example.test${url}` : url, headers: [], queryString: [], cookies: [], ...request },
  response: { status: 200, headers: [], cookies: [], content: { mimeType: J, text: JSON.stringify(res) } },
});
const postman = (item: unknown[], extra: object = {}): unknown => ({ info: { name: "Acme", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item, ...extra });
const pmGet = (url: string, res?: unknown, method = "GET"): unknown => ({
  request: { method, url: url.startsWith("/") ? `https://app.example.test${url}` : url },
  ...(res !== undefined ? { response: [{ code: 200, header: [{ key: "Content-Type", value: J }], body: JSON.stringify(res) }] } : {}),
});

/** The file `cairn api --spec` leaves for a HAR or a Postman collection, read back. */
async function derived(source: unknown, runSecrets: string[] = []): Promise<{ saved: string; doc: Doc; ingested: string }> {
  const d = deriveSpec(JSON.stringify(source), runSecrets)!;
  const dir = await mkdtemp(join(tmpdir(), "cairn-forms-"));
  try {
    const file = await writeDerivedSpec(dir, d.doc, [...d.secrets, ...runSecrets]);
    const saved = await readFile(file, "utf8");
    const ingested = await ingestOpenApi(file).then(
      () => "ok",
      (e: Error) => e.message,
    );
    return { saved, doc: JSON.parse(saved) as Doc, ingested };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const paths = (d: { doc: Doc }): string[] => Object.keys(d.doc.paths).sort();
const responseSchema = (d: { doc: Doc }, path: string): Schema => d.doc.paths[path]!.get!.responses["200"]!.content![J]!.schema!;
const requestSchema = (d: { doc: Doc }, path: string, media = J): Schema => d.doc.paths[path]!.post!.requestBody!.content[media]!.schema!;

/** Keys that each pass the form, the values all of one shape: a dictionary keyed by people. */
const people = (n: number): Record<string, { role: string; team: string | null }> => {
  const first = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy", "olena", "petro", "sofia", "taras", "yulia", "zoya"];
  const last = ["smith", "jones", "petrenko", "koval", "shevchenko", "bondar", "melnyk", "tkach", "moroz", "lysenko"];
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`${first[i % first.length]}_${last[Math.floor(i / first.length) % last.length]}`, { role: "viewer", team: i % 2 ? "ops" : null }]));
};

/** [what, the traffic, the strings the file must not hold, the run's secrets]. */
const NEVER_IN_THE_FILE: [string, Feed, string[], string[]?][] = [
  // A text or JSON body sent as a form, and a query part with no `=`, have no names.
  ["JSON body sent as a form", (r) => post(r, "/api/submit", FORM, JSON.stringify({ name: "Alice Smith", diagnosis: "private note" })), ["Alice Smith", "private note", "diagnosis"]],
  ["text sent as a form", (r) => post(r, "/api/submit", FORM, "this is my private message to Bob"), ["this is my private message to Bob", "private"]],
  ["JSON with a password sent as a form", (r) => post(r, "/api/submit", FORM, JSON.stringify({ login: "alice", password: "x" })), ["alice", "login", "password"]],
  ["bare query", (r) => get(r, "/api/lookup?Alice%20Smith"), ["Alice Smith", "Alice%20Smith"]],
  ["JSON as a query", (r) => get(r, '/api/lookup?{"note":"private"}'), ["private", "note"]],
  ["one bare word as a query", (r) => get(r, "/api/lookup?alice"), ["alice"]],
  ["one bare word as a form", (r) => post(r, "/api/submit", FORM, "alice"), ["alice"]],

  // A word in a path.
  ["Cyrillic name", (r) => get(r, "/api/x/Леонід"), ["Леонід", encodeURIComponent("Леонід")]],
  ["phone", (r) => get(r, "/api/x/+380441234567"), ["380441234567"]],
  ["invite token", (r) => get(r, "/api/x/x7f-9kq-2mz"), ["x7f-9kq-2mz"]],
  ["letters-only token", (r) => get(r, "/api/x/kdjfhgkdjfhgkdjf"), ["kdjfhgkdjfhgkdjf"]],
  ["short mixed id", (r) => get(r, "/api/x/a1b2c3d"), ["a1b2c3d"]],
  ["hex without digits", (r) => get(r, "/api/x/deadbeef"), ["deadbeef"]],
  ["file name", (r) => get(r, "/api/x/john_doe_passport.pdf"), ["john_doe_passport", "passport"]],
  ["e-mail without a dot", (r) => get(r, "/api/x/alice@corp"), ["alice"]],
  ["e-mail on a Cyrillic domain", (r) => get(r, "/api/x/олена@пошта.укр"), ["олена", encodeURIComponent("олена")]],
  ["a word longer than 32 characters", (r) => get(r, "/api/x/averyveryveryveryveryverylongwordinapath"), ["averyveryvery"]],
  ["a credential-shaped word that ends in digits", (r) => get(r, "/api/x/resettoken12345678"), ["resettoken12345678"]],
  ["five letters with no vowel", (r) => get(r, "/api/x/bcdfg"), ["bcdfg"]],
  ["a word with digits in it that is shaped like a credential", (r) => get(r, "/api/x/resettoken123"), ["resettoken123"]],
  ["a word that reads as :name", (r) => get(r, "/api/x/:alicesmith/y"), ["alicesmith"]],
  ["a word that reads as {name}", (r) => get(r, "/api/x/%7Balicesmith%7D/y"), ["alicesmith"]],
  [
    "people in the same place of a path",
    (r) => {
      for (const who of ["alice", "bob", "carol", "jane-roe", "john-doe"]) get(r, `/api/users/${who}/profile`);
    },
    ["alice", "bob", "carol", "jane-roe", "john-doe"],
  ],
  [
    "a slug a response names, the response after the path",
    (r) => {
      get(r, "/api/tenants/john-doe");
      get(r, "/api/lookup", answer({ slug: "john-doe" }));
    },
    ["john-doe"],
  ],

  // A key of a JSON object.
  ["person as a key", (r) => get(r, "/api/a", answer({ "Alice Smith": { role: "admin" } })), ["Alice Smith"]],
  ["phone as a key", (r) => get(r, "/api/a", answer({ "+380441234567": 1 })), ["380441234567"]],
  ["address as a key", (r) => get(r, "/api/a", answer({ "10.0.0.17": 1 })), ["10.0.0.17"]],
  ["a client's domain as a key", (r) => get(r, "/api/a", answer({ "customer-bank.example": 1 })), ["customer-bank"]],
  ["numeric id as a key", (r) => get(r, "/api/a", answer({ 1234567: { a: 1 } })), ["1234567"]],
  ["date as a key", (r) => get(r, "/api/a", answer({ "2026-11-05": 3 })), ["2026-11-05"]],
  ["text as a key in a request", (r) => post(r, "/api/a", J, JSON.stringify({ "private note text": 1 })), ["private note text"]],

  // Names: a query name or a form field has the same form as a key.
  ["query name that is a person", (r) => get(r, "/api/a?Alice%20Smith=1"), ["Alice Smith", "Alice%20Smith"]],
  ["query name that is an e-mail address", (r) => get(r, "/api/a?bob@example.com=1"), ["bob@example.com"]],
  ["query name with brackets", (r) => get(r, "/api/a?filter[alice]=1"), ["alice"]],
  ["form field that is a person", (r) => post(r, "/api/submit", FORM, "Alice%20Smith=1"), ["Alice Smith", "Alice%20Smith"]],
  ["run secret as a query name", (r) => get(r, "/api/a?opensesame=1"), ["opensesame"], ["opensesame"]],
  ["run secret as a key", (r) => get(r, "/api/a", answer({ opensesame: 1, id: 2 })), ["opensesame"], ["opensesame"]],
  ["run secret as a form field", (r) => post(r, "/api/submit", FORM, "opensesame=1&page=2"), ["opensesame"], ["opensesame"]],
  ["a cookie's value as a key", (r) => get(r, "/api/a", { requestHeaders: { cookie: "sess=plainsessionword" }, ...answer({ plainsessionword: 1, id: 2 }) }), ["plainsessionword"]],

  // A word of several parts equal to a value seen anywhere, and a word that is or holds a secret.
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
  ["a word that holds a run secret as a part", (r) => get(r, "/api/x/reset-opensesame"), ["opensesame"], ["opensesame"]],
  ["a word that holds a dashed run secret as parts", (r) => get(r, "/api/x/reset-open-sesame-now"), ["open-sesame"], ["open-sesame"]],
  ["a word that holds a credential as a part", (r) => get(r, "/api/x/old_plainsessionword", { requestHeaders: { cookie: "sess=plainsessionword" } }), ["plainsessionword"]],
  ["a key that holds a run secret as a part", (r) => get(r, "/api/a", answer({ opensesame_id: 1, id: 2 })), ["opensesame"], ["opensesame"]],
  ["a query name that holds a run secret as a part", (r) => get(r, "/api/a?x-opensesame=1&page=2"), ["opensesame"], ["opensesame"]],
  ["a form field that holds a run secret as a part", (r) => post(r, "/api/submit", FORM, "opensesame_hint=1&page=2"), ["opensesame"], ["opensesame"]],
  [
    "a value seen after 5050 others",
    (r) => {
      for (let n = 0; n < 101; n++) {
        const ids = Array.from({ length: 50 }, (_, i) => `3f2b9c1e-9a7d-4c11-8b2e-${String(n).padStart(6, "0")}${String(i).padStart(6, "0")}`);
        get(r, "/api/list", answer({ ids }));
      }
      get(r, "/api/vault/opensesame", answer({ password: "opensesame" }));
    },
    ["opensesame"],
  ],

  // A value under a name that says password, token, API key, cookie or secret is as secret as a cookie.
  ["a body's password, as a part of a word", (r) => { post(r, "/api/login", J, '{"password":"opensesame"}'); get(r, "/api/x/reset-opensesame"); }, ["opensesame"]],
  ["a body's password, as a key", (r) => { post(r, "/api/login", J, '{"password":"opensesame"}'); get(r, "/api/a", answer({ opensesame: 1, id: 2 })); }, ["opensesame"]],
  ["a body's password, as one word of a path", (r) => { post(r, "/api/login", J, '{"password":"opensesame"}'); get(r, "/api/vault/opensesame"); }, ["opensesame"]],
  ["an answer's token, as a part of a key", (r) => get(r, "/api/a", answer({ access_token: "plaintokenword", plaintokenword_id: 1, id: 2 })), ["plaintokenword"]],
  ["a token deep in an answer's array, as a key", (r) => get(r, "/api/a", answer({ users: [{ api_key: "plainkeyword" }], plainkeyword: 1, id: 2 })), ["plainkeyword"]],
  ["a list of tokens in an answer, as a key", (r) => get(r, "/api/a", answer({ tokens: ["plaintokenword"], plaintokenword_id: 1, id: 2 })), ["plaintokenword"]],
  ["a query's token, as a part of a word", (r) => get(r, "/api/x/old-plaintokenword?token=plaintokenword"), ["plaintokenword"]],
  ["a form's password, as a query name", (r) => { post(r, "/api/login", FORM, "password=plainformword"); get(r, "/api/a?plainformword=1&page=2"); }, ["plainformword"]],
  ["a form's password, as a word", (r) => { post(r, "/api/login", FORM, "password=plainformword"); get(r, "/api/vault/plainformword"); }, ["plainformword"]],
  ["a password in a JSON body sent as a form, as a word", (r) => { post(r, "/api/login", FORM, '{"password":"plainformword"}'); get(r, "/api/vault/plainformword"); }, ["plainformword"]],
  ["a secret on a request left out, as a word", (r) => { r.note({ method: "GET", url: "https://sso.example.test/in?token=plaintokenword", resourceType: "fetch", status: 200 }); get(r, "/api/vault/plaintokenword"); }, ["plaintokenword"]],

  // A secret in a slightly different spelling.
  ["a dashed secret with an underscore", (r) => get(r, "/api/x/open_sesame"), ["open_sesame"], ["open-sesame"]],
  ["a secret with a space, dashed", (r) => get(r, "/api/x/open-sesame"), ["open-sesame"], ["open sesame"]],
  ["a secret after a word in camelCase", (r) => get(r, "/api/resetOpensesame"), ["pensesame"], ["opensesame"]],
  ["a secret before a word in a key", (r) => get(r, "/api/a", answer({ opensesameId: 1, id: 2 })), ["pensesame"], ["opensesame"]],
  ["a secret in capitals before a word in a key", (r) => get(r, "/api/a", answer({ OPENSESAMEId: 1, id: 2 })), ["OPENSESAME"], ["opensesame"]],
  ["a cookie in quotes", (r) => get(r, "/api/sess/plainsessionword", { requestHeaders: { cookie: 'sess="plainsessionword"' } }), ["plainsessionword"]],
  ["a signed cookie", (r) => get(r, "/api/sess/plainsessionword", { requestHeaders: { cookie: "sess=s%3Aplainsessionword.abcdef" } }), ["plainsessionword"]],
  ["a cookie with a plus", (r) => get(r, "/api/x/plain-word", { requestHeaders: { cookie: "sess=plain+word" } }), ["plain-word"]],
  ["a secret in full-width letters", (r) => get(r, "/api/vault/opensesame"), ["opensesame"], ["ｏｐｅｎｓｅｓａｍｅ"]],
  ["a secret with a zero-width space", (r) => get(r, "/api/vault/opensesame"), ["opensesame"], ["open\u200bsesame"]],
  ["a secret with a soft hyphen", (r) => get(r, "/api/vault/opensesame"), ["opensesame"], ["open\u00adsesame"]],
  ["a secret with a non-breaking hyphen", (r) => get(r, "/api/x/open-sesame"), ["open-sesame"], ["open\u2011sesame"]],

  // A value of several words in another spelling.
  ["a name with a space, dashed", (r) => { get(r, "/api/lookup", answer({ name: "Jane Roe" })); get(r, "/api/u/jane-roe"); }, ["jane-roe"]],
  ["a slug with an underscore", (r) => { get(r, "/api/lookup", answer({ slug: "jane-roe" })); get(r, "/api/u/jane_roe"); }, ["jane_roe"]],
  ["a slug in camelCase", (r) => { get(r, "/api/lookup", answer({ slug: "jane-roe" })); get(r, "/api/u/janeRoe"); }, ["janeRoe"]],
  ["the local part of an address", (r) => { get(r, "/api/lookup", answer({ email: "jane-roe@corp.test" })); get(r, "/api/u/jane-roe"); }, ["jane-roe"]],
  ["a query value with a plus", (r) => get(r, "/api/u/jane-roe?who=jane+roe"), ["jane-roe"]],
  ["a value sent encoded", (r) => get(r, "/api/u/jane-roe", { requestHeaders: { "x-tenant": "jane%2Droe" } }), ["jane-roe"]],

  // A word and a name share one form.
  ...["my-private-note-about-bob", "hiv-clinic-in-kyiv-near-me", "hqzkvbtmzarwplng", "hqzkvbtmzarwplngxwqkdjfuehtzmpqa", "kqz-mwpt-rhx", "aBcDeFgHiJkL", "AbCdEfGhIjKlMnO", "dead-beef-cafe", "abcd-ef12", "emp4521", "nov1985"].flatMap((word): [string, Feed, string[]][] => [
    [`${word} as a word of a path`, (r) => get(r, `/api/x/${word}`), [word]],
    [`${word} as a key`, (r) => get(r, "/api/a", answer({ [word]: 1, id: 2, title: "x" })), [word]],
  ]),
  ["a sentence as a key", (r) => get(r, "/api/a", answer({ "this-is-my-private-message-to-bob-about-the-diagnosis": 1, id: 2 })), ["private-message"]],

  // A map.
  ["a dictionary of 160 people", (r) => get(r, "/api/a", answer(people(160))), ["alice", "smith", "petrenko"]],
  ["a dictionary of people, three at a time", (r) => { const all = Object.entries(people(30)); for (let i = 0; i < 30; i += 3) get(r, "/api/a", answer(Object.fromEntries(all.slice(i, i + 3)))); }, ["alice", "smith", "petrenko"]],
  ["an object most of whose keys are secrets is a map: its other key goes too", (r) => get(r, "/api/a", answer({ opensesame: 1, hunterword: 2, plain_key: 3 })), ["opensesame", "hunterword", "plain_key"], ["opensesame", "hunterword"]],

  // A parameter's name.
  ["a run secret names no parameter", (r) => get(r, "/api/opensesame/5/parts/6"), ["opensesame"], ["opensesame"]],
  ["a known slug names no parameter", (r) => { get(r, "/api/john-doe/5/parts/6"); get(r, "/api/lookup", answer({ slug: "john-doe" })); }, ["john-doe", "johnDoe"]],
  ["a dashed run secret names no parameter", (r) => get(r, "/api/open-sesame/5/parts/6"), ["open-sesame", "openSesame"], ["open-sesame"]],

  // A media type.
  ["a tenant in a request's media type", (r) => post(r, "/api/a", "application/vnd.tenant.acme-corp.v2+json", "{}"), ["acme-corp"]],
  ["an e-mail address as a media type", (r) => post(r, "/api/a", "alice@example.com", "{}"), ["alice@example.com"]],
  ["a customer in a response's media type", (r) => get(r, "/api/a", { responseContentType: "application/vnd.customer-77.bank+json", body: () => Promise.resolve("{}") }), ["customer-77"]],

  // The host and the port.
  ["the host and the port", (r) => get(r, "/api/a"), ["acme-tenant", "8443", "app.example.test"]],
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

/** [what, the traffic, every path the file must hold, the run's secrets]. */
const THE_ROUTES_STAY: [string, Feed, string[], string[]?][] = [
  ["resources with ids and their lists", (r) => { for (const p of ["/api/projects", "/api/projects/1", "/api/users", "/api/users/2", "/api/teams", "/api/teams/3"]) get(r, p); }, ["/api/projects", "/api/projects/{id}", "/api/teams", "/api/teams/{id}", "/api/users", "/api/users/{id}"]],
  ["four resources under /api/v1", (r) => { for (const p of ["/api/v1/projects/1", "/api/v1/users/2", "/api/v1/teams/3", "/api/v1/tasks/4"]) get(r, p); }, ["/api/v1/projects/{id}", "/api/v1/tasks/{id}", "/api/v1/teams/{id}", "/api/v1/users/{id}"]],
  ["words at the end of a path", (r) => { for (const p of ["/api/projects", "/api/users", "/api/teams", "/api/settings"]) get(r, p); }, ["/api/projects", "/api/settings", "/api/teams", "/api/users"]],
  ["an API version in an answer", (r) => get(r, "/api/v1/me", answer({ apiVersion: "v1" })), ["/api/v1/me"]],
  ["a source named in an answer", (r) => get(r, "/api/v1/me", answer({ source: "api" })), ["/api/v1/me"]],
  ["the words of a query's values", (r) => get(r, "/api/v1/me?source=api&v=v1"), ["/api/v1/me"]],
  ["a JSON:API type", (r) => { get(r, "/api/projects/1", answer({ data: { type: "projects", id: "1" } })); get(r, "/api/projects", answer({ data: [{ type: "projects" }] })); }, ["/api/projects", "/api/projects/{id}"]],
  ["a list of permissions", (r) => { get(r, "/api/me", answer({ permissions: ["projects", "users", "settings"] })); for (const p of ["/api/projects/1", "/api/users/2", "/api/settings/3"]) get(r, p); }, ["/api/me", "/api/projects/{id}", "/api/settings/{id}", "/api/users/{id}"]],
  ["a tab in a query", (r) => { get(r, "/app?tab=projects"); get(r, "/api/projects/1"); }, ["/api/projects/{id}", "/app"]],
  ["a person's one-word name in an answer: the limit of a one-word slug", (r) => get(r, "/api/users/alice", answer({ username: "alice" })), ["/api/users/alice"]],
  ["names at the end of a path: no number of them says they are names", (r) => { for (const who of ["alice", "bob", "carol"]) get(r, `/api/users/${who}`); }, ["/api/users/alice", "/api/users/bob", "/api/users/carol"]],
  ["the words of the form, as a path", (r) => { for (const w of ["created_at", "getUserById", "refresh-token-status", "alice_smith_hiv_positive"]) get(r, `/api/${w}`); }, ["/api/alice_smith_hiv_positive", "/api/created_at", "/api/getUserById", "/api/refresh-token-status"]],
  ["the attributes of a Set-Cookie are not its value", (r) => { get(r, "/api/a", { allHeaders: () => Promise.resolve<[string, string][]>([["set-cookie", "sess=plainsessionword; Path=/reports; SameSite=Strict"]]) }); get(r, "/api/strict/reports"); }, ["/api/a", "/api/strict/reports"]],
  ["a word of the vocabulary under a sensitive name", (r) => { post(r, "/api/login", J, '{"password":"string"}'); get(r, "/api/schema/string"); }, ["/api/login", "/api/schema/string"]],
  ["a word of the vocabulary as a cookie", (r) => get(r, "/api/settings/default/x", { requestHeaders: { cookie: "csrftoken=default" } }), ["/api/settings/default/x"]],
  ["a secret that is only a piece of a part", (r) => get(r, "/api/administrators"), ["/api/administrators"], ["admin"]],
];

/** [what, a HAR or a collection, the strings the file must not hold, the run's secrets]. */
const NEVER_IN_A_DERIVED_FILE: [string, unknown, string[], string[]?][] = [
  ["a HAR's query token, as a part of a word", har(harGet("/api/login?session_token=correcthorsebattery"), harGet("/api/x/reset-correcthorsebattery")), ["correcthorsebattery"]],
  ["a HAR's query token, as a key", har(harGet("/api/login?session_token=correcthorsebattery", { correcthorsebattery: 1, id: 2 })), ["correcthorsebattery"]],
  ["a HAR's query token, as a query name", har(harGet("/api/login?session_token=correcthorsebattery"), harGet("/api/a?correcthorsebattery=1&page=2")), ["correcthorsebattery"]],
  ["a HAR's password in a body, as a word", har({ ...(harGet("/api/login") as object), request: { method: "POST", url: "https://app.example.test/api/login", headers: [], postData: { mimeType: J, text: '{"password":"opensesame"}' } } }, harGet("/api/vault/opensesame")), ["opensesame"]],
  ["a HAR's value the secret reader names, as a part of a word", har(harGet("/api/login?pwd=plainpwdword"), harGet("/api/x/reset-plainpwdword")), ["plainpwdword"]],
  ["a HAR's cookie, as a part of a word", har(harGet("/api/x/reset-plainsessionword", {}, { cookies: [{ name: "sess", value: "plainsessionword" }] })), ["plainsessionword"]],
  ["a HAR's cookie, as a key", har(harGet("/api/a", { plainsessionword: 1, id: 2 }, { cookies: [{ name: "sess", value: "plainsessionword" }] })), ["plainsessionword"]],
  ["a HAR's address with a user and a password", har(harGet("https://plainuser:plainpassword@app.example.test/api/reset-plainpassword", { plainuser: 1, id: 2 })), ["plainpassword", "plainuser"]],
  ["a collection's API key variable, as a part of a word", postman([pmGet("/api/reset-plainkeyword")], { variable: [{ key: "api_key", value: "plainkeyword" }] }), ["plainkeyword"]],
  ["a collection's API key variable, as a key", postman([pmGet("/api/a", { plainkeyword: 1, id: 2 })], { variable: [{ key: "api_key", value: "plainkeyword" }] }), ["plainkeyword"]],
  ["a collection's value the secret reader names, as a part of a word", postman([pmGet("/api/reset-plainpwdword")], { variable: [{ key: "pwd", value: "plainpwdword" }] }), ["plainpwdword"]],
  ["a collection's API key in a query, as a part of a word", postman([pmGet("/api/reset-plainkeyword?api_key=plainkeyword")]), ["plainkeyword"]],
  ["a collection's address with a user and a password", postman([pmGet("https://plainuser:plainpassword@app.example.test/api/reset-plainpassword", { plainuser: 1, id: 2 })]), ["plainpassword", "plainuser"]],
  ["a run's secret in a collection's query name", postman([pmGet("/api/a?filter[opensesame]=1&page=2")]), ["opensesame"], ["opensesame"]],
  ["a run's secret in a collection's bare query", postman([pmGet("/api/a?opensesame&page=2")]), ["opensesame"], ["opensesame"]],
  ["a run's secret in a parameter a person named", postman([pmGet("/api/:opensesame/x")]), ["opensesame"], ["opensesame"]],
  ["a run's long secret in a request's name", postman([{ name: `Sign in with FAKE${"long".repeat(100)}`, request: { method: "GET", url: "https://app.example.test/api/a" } }]), ["longlong"], [`FAKE${"long".repeat(100)}`]],
  ["a run's secret with punctuation in a request's name", postman([{ name: "Sign in with FAKE.pass-word!", request: { method: "GET", url: "https://app.example.test/api/a" } }]), ["FAKE.pass-word!"], ["FAKE.pass-word!"]],
];

describe("what a HAR or a collection carries stays out of the file (#228, #229)", () => {
  it.each(NEVER_IN_A_DERIVED_FILE)("%s", async (_what, source, absent, runSecrets) => {
    const d = await derived(source, runSecrets);
    for (const a of absent) expect(d.saved, a).not.toContain(a);
    expect(d.ingested).toBe("ok");
  });
});

describe("what a person wrote in a collection stays (#228)", () => {
  const RESOURCES = ["projects", "users", "teams"];

  it("every path of three resources and of an action they share: no fold by position", async () => {
    const d = await derived(postman(RESOURCES.flatMap((res) => [pmGet(`/api/${res}`), pmGet(`/api/${res}`, undefined, "POST"), pmGet(`/api/${res}/:id`), pmGet(`/api/${res}/export`)])));
    const ops = Object.entries(d.doc.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m} ${p}`));
    expect(ops.filter((o) => o.endsWith("/export")).sort()).toEqual(["get /api/projects/export", "get /api/teams/export", "get /api/users/export"]);
    expect(ops.filter((o) => !o.endsWith("/export")).length).toBe(9);
    expect(paths(d).filter((p) => p.endsWith("{id}"))).toEqual(["/api/projects/{id}", "/api/teams/{id}", "/api/users/{id}"]);
  });

  it("a word equal to a value of the collection stays", async () => {
    const d = await derived(postman([pmGet("/api/jane-roe?who=jane-roe", { slug: "jane-roe" }), pmGet("/api/projects?tab=projects")]));
    expect(paths(d)).toEqual(["/api/jane-roe", "/api/projects"]);
  });

  it("words no recorded traffic may keep, when a person wrote them", async () => {
    const d = await derived(postman([pmGet("/api/my-private-note-about-bob"), pmGet("/api/report.csv"), pmGet("/api/v2.1/me"), pmGet("/api/emp4521")]));
    expect(paths(d)).toEqual(["/api/emp4521", "/api/my-private-note-about-bob", "/api/report.csv", "/api/v2.1/me"]);
  });

  it("the names of parameters, and query names of any form: a bare one, brackets, a dollar", async () => {
    const d = await derived(postman([pmGet("/api/:projectId/{{taskId}}?verbose&page[size]=10&filter[status]=open&$top=5&user.name=x")]));
    expect(paths(d)).toEqual(["/api/{projectId}/{taskId}"]);
    const names = d.doc.paths["/api/{projectId}/{taskId}"]!.get!.parameters!.filter((p) => p.in === "query").map((p) => p.name);
    expect(names).toEqual(["$top", "filter[status]", "page[size]", "user.name", "verbose"]);
  });

  it("the words around a secret: a word that holds it is a parameter, a request's name that does not hold it stays", async () => {
    const d = await derived(postman([pmGet("/api/reset-plainkeyword/x"), { name: "Latest projects", request: { method: "GET", url: "https://app.example.test/api/projects" } }], { info: { name: "Latest projects", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, variable: [{ key: "api_key", value: "plainkeyword" }, { key: "secret", value: "test" }] }));
    expect(paths(d)).toEqual(["/api/projects", "/api/{id}/x"]);
    expect(d.doc.info.title).toBe("Latest projects");
    expect(d.doc.paths["/api/projects"]!.get!.summary).toBe("Latest projects");
  });

  it("a HAR is recorded traffic: the same three paths fold, and a value folds its word", async () => {
    const d = await derived(har(...["projects", "users", "teams"].map((res) => harGet(`/api/${res}/export`)), harGet("/api/u/jane-roe?who=jane-roe")));
    expect(paths(d)).toEqual(["/api/u/{id}", "/api/{id}/export"]);
  });
});

describe("what must stay stays (#229)", () => {
  it.each(THE_ROUTES_STAY)("%s", async (_what, feed, expected, runSecrets) => {
    expect(paths(await draft(feed, runSecrets))).toEqual([...expected].sort());
  });

  it("the prices taken: a cookie's plain value folds its word, and three resources with a shared action become one route", async () => {
    const cookies = await draft((r) => {
      get(r, "/api/users/1", { requestHeaders: { cookie: "tab=users" } });
      get(r, "/api/dark/mode", { requestHeaders: { cookie: "theme=dark" } });
    });
    expect(paths(cookies)).toEqual(["/api/{apiId}/{id}", "/api/{id}/mode"]);
    const shared = await draft((r) => {
      for (const res of ["projects", "teams", "users"]) get(r, `/api/${res}/export`);
    });
    expect(paths(shared)).toEqual(["/api/{id}/export"]);
  });

  it("a value equal to its field's name is no secret: the key stays", async () => {
    const d = await draft((r) => get(r, "/api/a", answer({ session_token: "session_token", id: 2 })));
    expect(Object.keys(responseSchema(d, "/api/a").properties ?? {})).toEqual(["session_token", "id"]);
  });

  it("four parts stay: the limit of the form", async () => {
    const d = await draft((r) => get(r, "/api/a", answer({ alice_smith_hiv_positive: 1, id: 2 })));
    expect(Object.keys(responseSchema(d, "/api/a").properties ?? {})).toEqual(["alice_smith_hiv_positive", "id"]);
  });

  it("an object of 8 keys of one shape is a map, and of 7 or of other shapes is not", async () => {
    const of = (n: number, value: (i: number) => unknown): Record<string, unknown> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${"abcdefghij"[i]}key`, value(i)]));
    const d = await draft((r) => {
      get(r, "/api/eight", answer(of(8, () => ({ role: "x" }))));
      get(r, "/api/nulls", answer(of(8, (i) => (i ? { role: "x", team: i % 2 ? null : "y" } : null))));
      get(r, "/api/seven", answer(of(7, () => ({ role: "x" }))));
      get(r, "/api/other", answer(of(8, (i) => ({ [`field${"abcdefghij"[i]}`]: 1 }))));
      get(r, "/api/plain", answer(of(8, () => "x")));
    });
    for (const p of ["/api/eight", "/api/nulls"]) expect(responseSchema(d, p).properties, p).toBeUndefined();
    for (const p of ["/api/seven", "/api/other", "/api/plain"]) expect(responseSchema(d, p).properties, p).toBeDefined();
  });

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

  const NAMES = ["address1", "addressLine1", "addressLine2", "password1", "base64data", "oauth2token", "ipv4address", "sha256sum", "s3bucket", "phoneNumber2", "name", "email", "age", "created_at", "getUserById", "refresh-token-status"];
  const namesBody = Object.fromEntries(NAMES.map((k) => [k, "string"]));

  it("ordinary names stay names, in a request and in a response", async () => {
    const d = await draft((r) => {
      post(r, "/api/customers", J, JSON.stringify(namesBody));
      get(r, "/api/customers", answer(namesBody));
    });
    expect(Object.keys(requestSchema(d, "/api/customers").properties ?? {})).toEqual(NAMES);
    expect(Object.keys(responseSchema(d, "/api/customers").properties ?? {})).toEqual(NAMES);
  });

  it("one token-like key does not turn the object into a map, and the happy-path body keeps its fields", async () => {
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
      get(r, "/api/columns", answer({ column: "email", email: "x", label: "phone", phone: "y" }));
    });
    expect(Object.keys(requestSchema(d, "/api/projects").properties ?? {})).toEqual(["name", "public"]);
    expect(responseSchema(d, "/api/projects").items!.properties).toHaveProperty("name");
    expect(Object.keys(responseSchema(d, "/api/columns").properties ?? {})).toEqual(["column", "email", "label", "phone"]);
  });

  it("a part of a word is checked against secrets only, and only whole: `admin` leaves `administrators` alone", async () => {
    const d = await draft((r) => {
      get(r, "/api/administrators");
      get(r, "/api/reset-password", answer({ state: "active" }));
      get(r, "/api/set-active", answer({ word: "password", administrators: 1, admins_total: 2 }));
    }, ["admin"]);
    expect(paths(d)).toEqual(["/api/administrators", "/api/reset-password", "/api/set-active"]);
    expect(Object.keys(responseSchema(d, "/api/set-active").properties ?? {})).toEqual(["word", "administrators", "admins_total"]);
  });

  it("a key that holds a secret as a part is dropped alone", async () => {
    const d = await draft((r) => get(r, "/api/a", answer({ opensesame_id: 1, id: 2, title: "x" })), ["opensesame"]);
    expect(responseSchema(d, "/api/a").properties).toEqual({ id: { type: "integer" }, title: { type: "string" } });
    expect(responseSchema(d, "/api/a").required).toEqual(["id", "title"]);
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

describe("a long value does not stop the run (#229)", () => {
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

describe("a HAR's forms and a collection's free text (#228, #229)", () => {
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
