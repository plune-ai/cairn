/**
 * C1-04 / API-1 (#22) — the `api` modality, first slice.
 *
 * Scope of THIS slice: register the command and ingest an OpenAPI v3 spec into the internal model,
 * then print a verifiable summary of what was parsed ("N endpoints across M tags"). It does NOT
 * generate cases, run anything, or write to Plune — those are API-2 (#137) and API-3 (#138).
 */
import { resolve } from "node:path";
import { ingestOpenApi, type ApiModel } from "../../api/openapi.js";
import type { Modality, ModalityContext } from "../modality.js";

/** Parsed flags for `cairn api` (mirrors the command's option definitions). */
interface ApiFlags {
  spec?: string;
}

/** Is this a remote spec we hand to swagger-parser as-is, vs a local file path we resolve? */
function isUrl(spec: string): boolean {
  return /^https?:\/\//i.test(spec);
}

/** Print the parsed-model summary — the verifiable artifact of this slice. */
export function renderApiSummary(model: ApiModel, source: string): string[] {
  const lines = [
    `=== API spec: ${model.title ?? "(untitled)"}${model.version ? ` v${model.version}` : ""} (OpenAPI ${model.openapiVersion}) ===`,
    `Source: ${source}`,
    `${model.endpoints.length} endpoint(s) across ${model.tags.length} tag(s)` +
      (model.securitySchemes.length ? ` · ${model.securitySchemes.length} security scheme(s)` : ""),
  ];
  if (model.tags.length) lines.push(`Tags: ${model.tags.join(", ")}`);
  for (const e of model.endpoints) {
    const op = e.operationId ? ` (${e.operationId})` : "";
    const tag = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
    lines.push(`  ${e.method.padEnd(6)} ${e.path}${op}${tag}`);
  }
  lines.push("");
  lines.push("Note: ingest only (API-1). Case generation + runner land in API-2 (#137).");
  return lines;
}

export const apiModality: Modality = {
  name: "api",
  gated: false,
  summary: "Generate API / contract tests from an OpenAPI spec",
  async run(ctx: ModalityContext): Promise<void> {
    const opts = ctx.flags as ApiFlags;
    const spec = opts.spec;
    if (!spec) {
      // commander enforces requiredOption in the CLI; this guards programmatic/test callers.
      throw new Error("`cairn api` requires --spec <path|url> (an OpenAPI 3.x JSON/YAML spec).");
    }
    const source = isUrl(spec) ? spec : resolve(spec);
    ctx.err(`▸ Ingesting OpenAPI spec from ${source}…\n`);
    let model: ApiModel;
    try {
      model = await ingestOpenApi(source);
    } catch (e) {
      // Clean, non-crashing failure (acceptance): clear message, exit non-zero.
      ctx.err(`✗ ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    for (const line of renderApiSummary(model, source)) ctx.out(`${line}\n`);
  },
};
