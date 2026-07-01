import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateAdversarialCases, ADVERSARIAL_STYLES } from "../../src/api/adversarial.js";
import { ingestOpenApi, type ApiModel } from "../../src/api/openapi.js";

/**
 * BORROW-07 (#95): adversarial-style case generation — curious (exhaustive valid coverage), psycho
 * (invalid/malformed/extreme input), hacker (deterministic auth-strip subset). "normal" is a no-op
 * here by design (see adversarial.ts's module doc) — covered instead where the CLI tags base cases.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

function model(...endpoints: ApiModel["endpoints"]): ApiModel {
  return { openapiVersion: "3.0.0", endpoints, tags: [], securitySchemes: [] };
}

describe("curious — exhaustive valid coverage", () => {
  it("adds a full-params case only when an optional param exists", () => {
    const withOptional = model({
      method: "GET",
      path: "/x",
      tags: [],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "detail", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: [{ status: "200" }],
      security: [],
    });
    const cases = generateAdversarialCases(withOptional, ["curious"]);
    const full = cases.find((c) => c.name.includes("all params"));
    expect(full).toBeDefined();
    expect(full!.params.query).toEqual({ detail: "string" });
    expect(full!.adversarialStyle).toBe("curious");

    const allRequired = model({
      method: "GET",
      path: "/y",
      tags: [],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: [{ status: "200" }],
      security: [],
    });
    expect(generateAdversarialCases(allRequired, ["curious"])).toEqual([]);
  });

  it("adds one case per additional enum value (not the first, already covered by the happy path)", () => {
    const m = model({
      method: "POST",
      path: "/x",
      tags: [],
      parameters: [],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        schema: { type: "object", properties: { status: { type: "string", enum: ["active", "archived", "deleted"] } } },
      },
      responses: [{ status: "201" }],
      security: [],
    });
    const cases = generateAdversarialCases(m, ["curious"]);
    expect(cases).toHaveLength(2); // "archived" + "deleted" — "active" is the happy path's first value
    expect(cases.every((c) => c.adversarialStyle === "curious")).toBe(true);
    expect(cases.map((c) => (c.body as { status: string }).status).sort()).toEqual(["archived", "deleted"]);
    // Names stay unique per value.
    expect(new Set(cases.map((c) => c.name)).size).toBe(2);
  });

  it("contributes nothing for an operation with only required params and no enum", () => {
    const m = model({
      method: "GET",
      path: "/health",
      tags: [],
      parameters: [],
      responses: [{ status: "200" }],
      security: [],
    });
    expect(generateAdversarialCases(m, ["curious"])).toEqual([]);
  });
});

describe("psycho — invalid/malformed/extreme input", () => {
  it("generates a SQLi case and an XSS case targeting the first string body property", () => {
    const m = model({
      method: "POST",
      path: "/pets",
      tags: [],
      parameters: [],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
      responses: [{ status: "201" }],
      security: [],
    });
    const cases = generateAdversarialCases(m, ["psycho"]);
    const sqli = cases.find((c) => c.wstgId === "WSTG-INPV-05")!;
    const xss = cases.find((c) => c.wstgId === "WSTG-INPV-01")!;
    expect(sqli).toBeDefined();
    expect(xss).toBeDefined();
    expect((sqli.body as { name: string }).name).toBe("' OR '1'='1");
    expect((xss.body as { name: string }).name).toBe("<script>alert(1)</script>");
    expect(sqli.adversarialStyle).toBe("psycho");
    expect(sqli.expectedStatus).toBe("4XX"); // no declared 4xx on this op → generic range fallback
    expect(sqli.name).not.toBe(xss.name); // distinct cases targeting the same property must not collide
    expect(sqli.type).toBe("Negative"); // expects rejection — must not inherit the base case's "Positive"
    expect(xss.type).toBe("Negative");
  });

  it("generates a boundary-value case targeting the first numeric body property (no wstgId — not a WSTG category)", () => {
    const m = model({
      method: "POST",
      path: "/x",
      tags: [],
      parameters: [],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        schema: { type: "object", properties: { count: { type: "integer" } } },
      },
      responses: [{ status: "201" }],
      security: [],
    });
    const [boundary] = generateAdversarialCases(m, ["psycho"]).filter((c) => c.technique === "boundary-value");
    expect(boundary).toBeDefined();
    expect((boundary!.body as { count: number }).count).toBe(Number.MAX_SAFE_INTEGER);
    expect(boundary!.wstgId).toBeUndefined();
    expect(boundary!.type).toBe("Negative"); // expects rejection — must not inherit the base case's "Positive"
  });

  it("re-tags the existing API-8 negative case as psycho, renamed so it never collides with a plain --negative case", async () => {
    const petstore = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const psychoCases = generateAdversarialCases(petstore, ["psycho"]);
    const reused = psychoCases.find((c) => c.name.includes("(negative)"));
    expect(reused).toBeDefined();
    expect(reused!.adversarialStyle).toBe("psycho");
    expect(reused!.name).toBe("createPet (negative), reused"); // distinct from plain "createPet (negative)"
    expect(reused!.type).toBe("Negative"); // unchanged from the original API-8 negative case
  });

  it("skips an operation with nothing corruptible (no body at all)", async () => {
    const tiny = await ingestOpenApi(join(fixtures, "tiny.json"));
    // tiny.json's one bodyless op contributes no SQLi/XSS/boundary case — only a possible reused negative one.
    const cases = generateAdversarialCases(tiny, ["psycho"]);
    expect(cases.some((c) => c.wstgId)).toBe(false);
  });
});

describe("hacker — deterministic auth-strip subset", () => {
  it("generates a stripAuth case only for operations that declare security", async () => {
    const petstore = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const cases = generateAdversarialCases(petstore, ["hacker"]);
    // petstore: getPet/listPets/createPet inherit the spec-level `security: [apiKey]`; deletePet
    // explicitly overrides to `security: []` (public) and must be skipped.
    expect(cases).toHaveLength(3);
    expect(cases.every((c) => c.stripAuth === true)).toBe(true);
    expect(cases.every((c) => c.adversarialStyle === "hacker")).toBe(true);
    expect(cases.every((c) => c.wstgId === "WSTG-ATHN-04")).toBe(true);
    expect(cases.every((c) => c.type === "Negative")).toBe(true); // expects rejection, not the base case's "Positive"
    expect(cases.some((c) => c.name.startsWith("deletePet"))).toBe(false);
  });

  it("expects rejection (4xx), not the happy path's declared success", async () => {
    const petstore = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const [hackerCase] = generateAdversarialCases(petstore, ["hacker"]);
    expect(hackerCase!.expectedStatus).not.toBe("200");
    expect(/^4/.test(hackerCase!.expectedStatus) || hackerCase!.expectedStatus === "4XX").toBe(true);
  });

  // Bug #154, found live: an operation can declare a 4xx unrelated to auth (e.g. petstore's getPet
  // only declares 404 "not found") — the auth-strip case must not blindly reuse "the lowest declared
  // 4xx" for that, since a server correctly enforcing auth (401) would then fail a case that expected
  // the wrong failure mode entirely.
  it("(#154) prefers a declared 401 over any other declared 4xx", () => {
    const m = model({
      method: "GET",
      path: "/x",
      tags: [],
      parameters: [],
      responses: [{ status: "200" }, { status: "404" }, { status: "401" }],
      security: ["apiKey"],
    });
    const [hackerCase] = generateAdversarialCases(m, ["hacker"]);
    expect(hackerCase!.expectedStatus).toBe("401");
  });

  it("(#154) prefers a declared 403 when no 401 is declared", () => {
    const m = model({
      method: "GET",
      path: "/x",
      tags: [],
      parameters: [],
      responses: [{ status: "200" }, { status: "404" }, { status: "403" }],
      security: ["apiKey"],
    });
    const [hackerCase] = generateAdversarialCases(m, ["hacker"]);
    expect(hackerCase!.expectedStatus).toBe("403");
  });

  it("(#154) falls back to the generic lowest-4xx when neither 401 nor 403 is declared (petstore's getPet: only 404)", async () => {
    const petstore = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const getPetCase = generateAdversarialCases(petstore, ["hacker"]).find((c) => c.name.startsWith("getPet"));
    expect(getPetCase!.expectedStatus).toBe("404");
  });
});

describe("style selection", () => {
  it("generates nothing when no styles are requested", async () => {
    const petstore = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    expect(generateAdversarialCases(petstore, [])).toEqual([]);
  });

  it("ADVERSARIAL_STYLES lists all four named styles", () => {
    expect(ADVERSARIAL_STYLES).toEqual(["normal", "curious", "psycho", "hacker"]);
  });

  it("combining all styles produces no duplicate case names for one spec", async () => {
    const petstore = await ingestOpenApi(join(fixtures, "petstore.yaml"));
    const cases = generateAdversarialCases(petstore, ADVERSARIAL_STYLES);
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
