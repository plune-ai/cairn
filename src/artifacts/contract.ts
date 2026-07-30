import { createHash } from "node:crypto";

/**
 * Version of the run-artifact format — `report.json` and the case files written beside it.
 *
 * The artifact is a PUBLIC output contract, not an internal dump: anything that reads a Cairn run
 * parses it — a dashboard, a test-management system, another tool. Without a version a change here
 * breaks those readers silently and at a distance, and the reader cannot even tell it is looking at
 * something newer than it understands. Bump this whenever the shape changes in a way a reader could
 * notice, and say so in the CHANGELOG.
 */
export const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Which kind of run produced an artifact.
 *
 * Every artifact carries this, INCLUDING a partial one from a failed run — otherwise a reader has to
 * infer the kind from which optional keys happen to be present, which is a guess that silently starts
 * returning the wrong answer the moment a key becomes optional.
 */
export type RunMode = "explore" | "design" | "api";

/**
 * A stable, content-derived identity for a generated case.
 *
 * The ids a run hands out — `tc-3`, `ATC-LOGIN-003` — answer "which case is this *within this run*".
 * They are positions, so the same case gets a different one as soon as the model designs a different
 * number of cases, or orders them differently. That is a correct answer to a different question.
 *
 * This answers "is this the same case we saw last time", which is what dedup ACROSS runs needs — ours
 * (the experience tracker `--fresh` turns off) and any consumer's. Keeping the two as separate fields
 * is deliberate: they are different concepts, and collapsing them into one id was the original mistake.
 *
 * Derived from the case's substance, normalised so casing and whitespace do not mint a new identity.
 * Truncated to 12 hex chars — a collision needs on the order of 16M cases for one target, which is far
 * past any run we could produce.
 *
 * KNOWN LIMIT, measured rather than assumed. This is EXACT-content identity, so it is fully stable for
 * a deterministic generator (`api` cases derived from a spec: two runs produced 26/26 identical ids),
 * and it is NOT sufficient on its own for LLM-designed cases — two `design` runs over the same page
 * reworded their cases and shared zero identities.
 *
 * That is still a strict improvement over the positional `id`, and the reason is worth being precise
 * about: a positional id produces FALSE matches (`tc-3` in one run is a different case from `tc-3` in
 * the next, while looking exactly like a match). This produces none — it either matches truly or
 * reports that it does not know. Going from silently-wrong to honestly-unknown is the part that makes
 * dedup safe; closing the remaining gap for reworded cases is what `design/dedup.ts` `caseSimilarity`
 * already does, and a consumer that needs it should reach for similarity, not for this.
 */
export function stableCaseId(parts: readonly (string | undefined)[]): string {
  const substance = parts
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, " "));
  // NUL-joined, not space-joined: only a separator that cannot occur inside a part stops one part
  // ("ab c") from hashing identically to two ("ab", "c").
  return createHash("sha256").update(substance.join("\u0000")).digest("hex").slice(0, 12);
}

/**
 * The identity of a DESIGNED (UI) case — defined once, because three separate places mint these cases
 * (the design pass, the critique top-up, the gap filler). Three copies of the formula would drift into
 * three different identities for the same case, and the drift would only show up as a broken dedup.
 *
 * `elementRefs` is deliberately excluded: grounding detail can change with the page without the case
 * becoming a different case.
 */
export function designedCaseStableId(c: {
  title: string;
  technique: string;
  type: string;
  expected: string;
  steps: readonly string[];
}): string {
  return stableCaseId([c.title, c.technique, c.type, c.expected, ...c.steps]);
}
