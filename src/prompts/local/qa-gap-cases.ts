/**
 * #61 — gap-case suggester. Given the observed-but-untested interactive elements, propose test cases
 * that close the gaps. Worker-tier. Output is treated as SUGGESTIONS (gap- id prefix). Does not touch
 * the design methodology — it reuses the same case shape, scoped to the untested surface.
 */
export const QA_GAP_CASES = `You are a QA engineer reviewing test COVERAGE. Below are interactive elements that were observed on the app but are NOT referenced by any existing test case — the coverage gaps.
Write all titles, steps, expected in {{language}} — do not mix languages in your own wording. Text the page itself shows (button labels, headings, messages, placeholders) that a step clicks or an expected result checks for is quoted verbatim in the page's own language, never translated, so the test looks for the string that is really there.

Page purpose:
{{pageSemantics}}

Untested elements (ref · role · name · page — why it matters). In elementRefs use ONLY these refs:
{{gaps}}

Suggest focused test cases that close these gaps. For each case: title, technique (29119-4), kind ("static"|"active"), type ("Positive"|"Negative"), execution ("auto"|"manual"), preconditions, steps (real labels), expected (verifiable), priority, elementRefs (only from the list above).

RULES:
- Page-only actions are automated: click, toggle, type, key press, hover, a browser dialog (accept / dismiss / answer), adding or removing an element on the page, opening or closing an overlay, sorting or filtering a table; their effect stays in the browser. Only an action that changes data on a server or the session (a submit that sends data, deleting a saved record, a payment, sending a message, signing out) is left to a human: check that its control is VISIBLE and do not perform it. Judge an action by what it does, never by a word in its label such as Add or Remove.
- One logical check per case; independent; start from a clean page.
- Only reference the untested refs above — do not invent elements or re-test already-covered ones.
- These are SUGGESTIONS to fill coverage gaps; keep them concrete and runnable.`;
