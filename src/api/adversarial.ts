/**
 * BORROW-07 (#95) — adversarial API testing styles, borrowed conceptually from testomatio/explorbot's
 * Chief+Curler (4 named styles: normal/curious/psycho/hacker) and AZANIR/qa-skills' OWASP WSTG payload
 * set (both harvested via BORROW-08, #96). Explorbot's own styles are LLM-driven — Chief plans and
 * Curler composes each request's literal payload at generation time, with no deterministic
 * style→value mapping anywhere to port. This ports the TAXONOMY only, translated into cairn's
 * existing schema-driven, no-LLM case generation (same "no LLM" reasoning as API-2/API-8).
 *
 * - normal   — happy path. Already always-generated (API-2) — this module doesn't re-emit it as a
 *   separate case; the CLI layer just tags the existing base cases when "normal" is requested.
 * - curious  — exhaustive VALID coverage: a case with every param (not just required), and one case
 *   per additional declared enum value. Body completeness needed no new code — `synth()` (`cases.ts`)
 *   already includes every synthesisable property regardless of required-ness.
 * - psycho   — invalid/malformed/extreme input: a SQL-injection case, an XSS case, a boundary-numeric
 *   case (each targeting the first suitable body property), plus API-8's existing negative case
 *   (missing-required-field / wrong-type), re-tagged rather than reimplemented.
 * - hacker   — ships only the deterministic, single-request slice: strip auth from an otherwise-valid
 *   request, expect rejection. IDOR / privilege-escalation-via-response-replay are genuinely
 *   stateful/multi-request in explorbot's own implementation (≥2 identities, resource chaining,
 *   reading prior responses) — closer to API-9's scenario-chain machinery than a single case, so
 *   they're a follow-up, not shipped here.
 *
 * Every case is tagged `adversarialStyle` (+ `wstgId` where a specific OWASP WSTG test ID applies) so
 * it flows through the existing run/report/coverage/ATC pipeline untouched — a distinct category, not
 * a parallel one (same principle API-8's `type: "Negative"` established). Coverage (API-6,
 * `computeApiCoverage`) needs no changes — it's endpoint/status-driven, not case-count-driven.
 */
import {
  apiEndpointKey,
  corruptibleProps,
  enumProps,
  generateNegativeCases,
  pickErrorSchema,
  pickErrorStatus,
  synthAllParams,
  toCase,
  type ApiCase,
  type ApiCaseTechnique,
} from "./cases.js";
import type { ApiEndpoint, ApiModel } from "./openapi.js";

export type AdversarialStyle = "normal" | "curious" | "psycho" | "hacker";
export const ADVERSARIAL_STYLES: readonly AdversarialStyle[] = ["normal", "curious", "psycho", "hacker"];

/** Known-safe (non-destructive) payloads, per qa-skills' own convention: verify rejection/sanitisation
 * happened, never assert that an attack actually succeeded. */
const SQLI_PAYLOAD = "' OR '1'='1";
const XSS_PAYLOAD = "<script>alert(1)</script>";
const BOUNDARY_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * Generate `curious`/`psycho`/`hacker` adversarial cases for the requested styles ("normal" is a
 * no-op here — see module doc). Cases are additive, meant to sit alongside the always-generated
 * happy-path cases in the same flat array (same pattern as API-8's `--negative`).
 */
export function generateAdversarialCases(model: ApiModel, styles: readonly AdversarialStyle[]): ApiCase[] {
  const cases: ApiCase[] = [];
  if (styles.includes("curious")) cases.push(...model.endpoints.flatMap(toCuriousCases));
  if (styles.includes("psycho")) cases.push(...model.endpoints.flatMap(toPsychoCases), ...reusedNegativeCases(model, "psycho"));
  if (styles.includes("hacker")) cases.push(...model.endpoints.map(toHackerCase).filter((c): c is ApiCase => c !== undefined));
  return cases;
}

/**
 * Exhaustive-valid-data cases for one operation (`curious`): a full-params variant (only when the op
 * actually has an optional param to add) and one case per additional declared enum value (only when
 * the body schema actually declares one) — an operation with neither contributes nothing, same
 * "nothing to add, skip" convention as API-8's negative cases.
 */
function toCuriousCases(e: ApiEndpoint): ApiCase[] {
  const base = toCase(e);
  const cases: ApiCase[] = [];

  if (e.parameters.some((p) => !p.required)) {
    cases.push({
      ...base,
      name: `${apiEndpointKey(e)} (curious: all params)`,
      params: synthAllParams(e),
      adversarialStyle: "curious",
      technique: "equivalence-partitioning",
      rationale:
        `Exhaustive-coverage case (curious style) for ${e.method} ${e.path}: exercises every ` +
        `parameter, including optional ones the happy path omits, still with schema-valid values.`,
    });
  }

  for (const [prop, values] of enumProps(e.requestBody?.schema)) {
    for (const value of values.slice(1)) {
      const body = { ...(base.body as Record<string, unknown>), [prop]: value };
      cases.push({
        ...base,
        name: `${apiEndpointKey(e)} (curious: ${prop}=${String(value)})`,
        body,
        adversarialStyle: "curious",
        technique: "equivalence-partitioning",
        rationale:
          `Exhaustive-coverage case (curious style) for ${e.method} ${e.path}: sends "${prop}" as the ` +
          `declared enum value ${JSON.stringify(value)} (the happy path only exercises the first).`,
      });
    }
  }

  return cases;
}

/**
 * Invalid/malformed/extreme-input cases for one operation (`psycho`): SQL injection and XSS in the
 * first string body property, an extreme boundary value in the first numeric one — each only when
 * such a property actually exists. Missing-required-field/wrong-type is NOT reimplemented here;
 * `reusedNegativeCases` re-tags API-8's existing negative case instead.
 */
function toPsychoCases(e: ApiEndpoint): ApiCase[] {
  const base = toCase(e);
  if (base.body === undefined || typeof base.body !== "object") return [];

  const props = corruptibleProps(e.requestBody?.schema);
  const stringProp = props.find(([, type]) => type === "string");
  const numericProp = props.find(([, type]) => type === "integer" || type === "number");
  const expectedStatus = pickErrorStatus(e);
  const expectedSchema = pickErrorSchema(e, expectedStatus);
  const cases: ApiCase[] = [];

  if (stringProp) {
    const [name] = stringProp;
    cases.push(
      psychoCase(e, base, "sqli", name, SQLI_PAYLOAD, expectedStatus, expectedSchema, "WSTG-INPV-05",
        `sends a SQL-injection payload in "${name}", expecting the API to reject or sanitise it ` +
          `(${expectedStatus}) rather than execute it`),
    );
    cases.push(
      psychoCase(e, base, "xss", name, XSS_PAYLOAD, expectedStatus, expectedSchema, "WSTG-INPV-01",
        `sends an XSS payload in "${name}", expecting the API to reject or sanitise it ` +
          `(${expectedStatus}) rather than reflect it unescaped`),
    );
  }
  if (numericProp) {
    const [name] = numericProp;
    cases.push(
      psychoCase(e, base, "boundary", name, BOUNDARY_INTEGER, expectedStatus, expectedSchema, undefined,
        `sends an extreme boundary value (${BOUNDARY_INTEGER}) for "${name}", expecting the API to ` +
          `reject it (${expectedStatus}) rather than accept an out-of-range number`),
    );
  }
  return cases;
}

function psychoCase(
  e: ApiEndpoint,
  base: ApiCase,
  attack: string,
  prop: string,
  value: unknown,
  expectedStatus: string,
  expectedSchema: unknown,
  wstgId: string | undefined,
  rationale: string,
): ApiCase {
  const body = { ...(base.body as Record<string, unknown>), [prop]: value };
  const technique: ApiCaseTechnique = wstgId ? "error-guessing" : "boundary-value";
  return {
    ...base,
    name: `${apiEndpointKey(e)} (psycho: ${attack})`,
    body,
    expectedStatus,
    expectedSchema,
    type: "Negative", // expects rejection, same category as an API-8 negative case
    adversarialStyle: "psycho",
    technique,
    ...(wstgId ? { wstgId } : {}),
    rationale: `Adversarial case (psycho style${wstgId ? `, ${wstgId}` : ""}) for ${e.method} ${e.path}: ${rationale}.`,
  };
}

/**
 * Auth-header-stripped case for one operation (`hacker`, deterministic subset — see module doc): only
 * for operations that actually declare `security`, since a public operation has nothing to strip.
 */
function toHackerCase(e: ApiEndpoint): ApiCase | undefined {
  if (e.security.length === 0) return undefined;
  const base = toCase(e);
  const expectedStatus = pickErrorStatus(e);
  return {
    ...base,
    name: `${apiEndpointKey(e)} (hacker: no-auth)`,
    expectedStatus,
    expectedSchema: pickErrorSchema(e, expectedStatus),
    type: "Negative", // expects rejection, same category as an API-8 negative case
    adversarialStyle: "hacker",
    wstgId: "WSTG-ATHN-04",
    stripAuth: true,
    technique: "error-guessing",
    rationale:
      `Adversarial case (hacker style, WSTG-ATHN-04) for ${e.method} ${e.path}: resends the ` +
      `happy-path request with authentication stripped, expecting the API to reject it ` +
      `(${expectedStatus}) rather than allow unauthenticated access.`,
  };
}

/** Re-tag API-8's existing negative cases (missing-required-field / wrong-type) as the given
 * adversarial style, rather than reimplementing the same "corrupt one property" logic. Renamed (not
 * just re-tagged) so a case list stays unique-by-name even when `--negative` and `--adversarial` are
 * both passed and would otherwise generate the identical underlying case twice — `renderApiCases`
 * already shows the style as its own `[psycho]` tag, so the name suffix here is a plain disambiguator
 * rather than repeating that same bracket. */
function reusedNegativeCases(model: ApiModel, style: AdversarialStyle): ApiCase[] {
  return generateNegativeCases(model).map((c) => ({ ...c, name: `${c.name}, reused`, adversarialStyle: style }));
}
