/**
 * #61 — gap-case suggester. Given the observed-but-untested interactive elements, propose test cases
 * that close the gaps. Worker-tier. Output is treated as SUGGESTIONS (gap- id prefix). Does not touch
 * the design methodology — it reuses the same case shape, scoped to the untested surface.
 */
export const QA_GAP_CASES = `You are a QA engineer reviewing test COVERAGE. Below are interactive elements that were observed on the app but are NOT referenced by any existing test case — the coverage gaps.
Write all titles, steps, expected in {{language}} — do not mix languages.

Page purpose:
{{pageSemantics}}

Untested elements (ref · role · name · page — why it matters). In elementRefs use ONLY these refs:
{{gaps}}

Suggest focused test cases that close these gaps. For each case: title, technique (29119-4), kind ("static"|"active"), type ("Positive"|"Negative"), execution ("auto"|"manual"), preconditions, steps (real labels), expected (verifiable), priority, elementRefs (only from the list above).

RULES:
- Read-only by default: assert visibility/state. For destructive/irreversible controls (Delete, Submit that writes, Log out) only assert VISIBLE — never perform the action.
- One logical check per case; independent; start from a clean page.
- Only reference the untested refs above — do not invent elements or re-test already-covered ones.
- These are SUGGESTIONS to fill coverage gaps; keep them concrete and runnable.`;
