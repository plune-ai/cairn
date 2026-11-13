/**
 * C1-01 — the modality registry: the single list every surface (CLI, tests) reads.
 *
 * `explore`, `api` and `collect-docs` (#24) are REAL modalities. ui/unit are GATED stubs (L-G2 / #25):
 * placeholders with no `run`, pulled one at a time by named demand. Adding a modality = append one
 * entry (+ a `run` that consumes the shared core).
 */
import { defaultIO, gatedNotice } from "./modality.js";
import type { IO, Modality } from "./modality.js";
import { exploreModality } from "./modalities/explore.js";
import { apiModality } from "./modalities/api.js";
import { collectDocsModality } from "./modalities/collect-docs.js";
import { checkDocsModality } from "./modalities/check-docs.js";
import { mcpTestModality } from "./modalities/mcp-test.js";

export const MODALITIES: Modality[] = [
  exploreModality,
  {
    name: "ui",
    aliases: ["e2e"],
    gated: true,
    summary: "Generate UI / end-to-end tests",
    hint: "For UI test generation today, use: cairn explore --url <url>",
  },
  // `api` is being built one slice at a time (#22): API-1 ships OpenAPI ingest + summary (no
  // generation yet). It is a REAL modality now — registered with its own `--spec` command below.
  apiModality,
  { name: "unit", gated: true, summary: "Generate unit tests" },
  // #24: the docs stub became `collect-docs` (alias `docs`), registered with its own command.
  collectDocsModality,
  // #231: the same walk, compared with docs in that format.
  checkDocsModality,
  // MCP-E1: read a foreign MCP server and record its model (no cases yet).
  mcpTestModality,
];

/** Look up a modality by its name or one of its aliases (e.g. `e2e` → the `ui` modality). */
export function getModality(nameOrAlias: string): Modality | undefined {
  return MODALITIES.find((m) => m.name === nameOrAlias || (m.aliases?.includes(nameOrAlias) ?? false));
}

/**
 * Dispatch a modality command — the single entry point the CLI actions and tests both drive.
 * Gated stubs print the coming-soon notice (no generation logic ever runs); a real modality runs
 * through its `run`. An unknown name throws.
 */
export async function runModality(
  name: string,
  flags: Record<string, unknown>,
  io: IO = defaultIO,
): Promise<void> {
  const m = getModality(name);
  if (!m) throw new Error(`Unknown modality "${name}".`);
  if (!m.run) {
    for (const line of gatedNotice(m)) io.out(`${line}\n`);
    return;
  }
  await m.run({ flags, out: io.out, err: io.err, isTTY: io.isTTY });
}
