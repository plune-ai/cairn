/**
 * C1-01 — the modality registry: the single list every surface (CLI, tests) reads.
 *
 * `explore` (UI) is the only REAL modality today. ui/api/unit/docs are GATED stubs (L-G2 / #25):
 * placeholders with no `run`, pulled one at a time by named demand. Adding a modality = append one
 * entry (+ a `run` that consumes the shared core). #21–24 stay gated until a named user pulls.
 */
import { defaultIO, gatedNotice } from "./modality.js";
import type { IO, Modality } from "./modality.js";
import { exploreModality } from "./modalities/explore.js";

export const MODALITIES: Modality[] = [
  exploreModality,
  {
    name: "ui",
    aliases: ["e2e"],
    gated: true,
    summary: "Generate UI / end-to-end tests",
    hint: "For UI test generation today, use: cairn explore --url <url>",
  },
  { name: "api", gated: true, summary: "Generate API / contract tests" },
  { name: "unit", gated: true, summary: "Generate unit tests" },
  { name: "docs", gated: true, summary: "Generate docs / doctest examples" },
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
  await m.run({ flags, out: io.out, err: io.err });
}
