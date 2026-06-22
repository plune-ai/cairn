/**
 * #59 — journey design prompt. Generates multi-page USER JOURNEY cases from the observed page/flow
 * graph. SEPARATE from the per-page design prompt — it does not redesign per-page cases and does not
 * touch the methodology / assertion-safety rules in `qa-testcase-from-ui`.
 */
export const QA_JOURNEY_FROM_FLOW = `You are an experienced QA engineer. From the observed page/flow GRAPH below, design end-to-end USER JOURNEY test cases that span MULTIPLE pages (e.g. login → dashboard → action).
Write all titles, actions, expected in {{language}} — do not mix languages.

Pages studied (each with its REAL interactive elements — ref · role · name). In a step's elementRefs use ONLY refs from THAT step's page — never invent refs and never use a ref from another page:
{{pages}}

Observed transitions between pages (act→observe — these are REAL navigations you may rely on):
{{edges}}

Design journeys that cross page boundaries. For each journey:
- title — concise title of the end-to-end flow;
- technique — applied 29119-4 technique (state-transition fits multi-step flows well);
- type — "Positive" | "Negative";
- preconditions — what must be true before the journey starts (e.g. "a registered user");
- steps — an ORDERED list; each step has: page (one of the page URLs above), action (real labels), elementRefs (refs from THAT page only);
- expected — a single verifiable end state;
- priority — critical | high | medium | low.

RULES (a journey is a TEST — keep it safe and runnable):
- A journey MUST span at least TWO distinct pages (≥2 different page URLs across its steps). Single-page checks are NOT journeys — omit them.
- Read-only by default: assert visibility/state. For destructive/irreversible controls (Delete, Remove, Submit that writes, Log out) only assert the control is VISIBLE — do NOT perform the action.
- Each step is grounded on its page's observed elements; do not assume elements the graph did not show.
- Prefer journeys that follow the OBSERVED transitions above (they are known to work).`;
