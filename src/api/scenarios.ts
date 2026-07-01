/**
 * C1-04 / API-9 (#146) — multi-endpoint scenario chains ("journeys" for the API modality): given the
 * {@link ApiModel}, generate ordered chains of related operations on the same resource (create → read
 * → update → delete, using whichever of those the spec actually declares), so a scenario can prove a
 * resource's identifier really flows from one response into the next request — something no
 * single-operation case (API-2/API-8) can express.
 *
 * "Related" = same resource, detected the same way REST APIs are conventionally shaped: a *collection*
 * path (`/pets`) and an *item* path templated one level deeper (`/pets/{id}`). No LLM, no new schema
 * keywords — pure structural grouping over the already-ingested model (API-1).
 *
 * A scenario step IS a normal {@link ApiCase} (from `toCase()`, API-2's exact synthesis) — nothing new
 * to learn for rendering/reporting. The only scenario-specific behaviour lives in the runner
 * (`scenario-runner.ts`): before sending a downstream step, it overwrites any of that step's params
 * whose name matches a value captured from an earlier step's response (declared `links` first, a
 * same-name field second — see `ApiCase.responseLinks`).
 */
import { apiEndpointKey, toCase, type ApiCase } from "./cases.js";
import type { ApiEndpoint, ApiModel } from "./openapi.js";

export interface ApiScenario {
  /** e.g. "pets lifecycle" — derived from the resource's collection path. */
  name: string;
  /** In CRUD order (whichever of create/read/update/delete the spec actually declares). */
  steps: ApiCase[];
  technique: "state-transition"; // ISO/IEC/IEEE 29119-4: a case exercising a resource's lifecycle
  rationale: string;
}

/**
 * A path's *collection* form: the path with a trailing `{param}` segment stripped, e.g.
 * `/pets/{id}` → `/pets`. A path with no trailing template segment is already a collection path.
 */
function collectionPathOf(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1];
  if (last && /^\{.+\}$/.test(last)) return segments.slice(0, -1).join("/") || "/";
  return path;
}

/** Group endpoints by their collection path — the candidate "same resource" grouping. */
function groupByResource(model: ApiModel): Map<string, ApiEndpoint[]> {
  const groups = new Map<string, ApiEndpoint[]>();
  for (const e of model.endpoints) {
    const key = collectionPathOf(e.path);
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }
  return groups;
}

/** Generate one lifecycle scenario per resource that has both a create op and something to chain it
 * to — a resource with only a create (nothing to read/update/delete) has no chain worth generating. */
export function generateApiScenarios(model: ApiModel): ApiScenario[] {
  const scenarios: ApiScenario[] = [];
  for (const [collectionPath, endpoints] of groupByResource(model)) {
    const itemOps = endpoints.filter((e) => e.path !== collectionPath);
    const create = endpoints.find((e) => e.path === collectionPath && e.method === "POST" && e.requestBody);
    if (!create) continue;

    const read = itemOps.find((e) => e.method === "GET");
    const update = itemOps.find((e) => e.method === "PUT" || e.method === "PATCH");
    const del = itemOps.find((e) => e.method === "DELETE");
    const downstream = [read, update, del].filter((e): e is ApiEndpoint => e !== undefined);
    if (downstream.length === 0) continue;

    const resourceName = collectionPath.replace(/^\//, "") || collectionPath;
    const chain = [create, ...downstream];
    scenarios.push({
      name: `${resourceName} lifecycle`,
      steps: chain.map(toCase),
      technique: "state-transition",
      rationale:
        `Chains ${chain.length} related operations on ${collectionPath} (${chain.map((e) => apiEndpointKey(e)).join(" → ")}), ` +
        `threading the resource identifier captured from ${apiEndpointKey(create)}'s response into each ` +
        `downstream request (state-transition, ISO/IEC/IEEE 29119-4) — the API analogue of a multi-page journey.`,
    });
  }
  return scenarios;
}
