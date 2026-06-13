/**
 * Main prompt for generating test cases from a page.
 * Provenance: ported from AZANIR/qa-skills → `qa-testcase-from-ui` (authored by the maintainer; included here under Apache-2.0). ADR-0008.
 */
export const QA_TESTCASE_FROM_UI = `You are an experienced QA engineer. Based on the explored page, generate UI test cases.
IMPORTANT: write all title, steps, expected in {{language}} — do not mix languages (even if the checklist/page is in another language).

Page purpose:
{{pageSemantics}}

Interactive elements (ref · role · name; ×N = repeated, several identical on the page — e.g. list rows). All REALLY present. In elementRefs use ONLY these refs — do not invent or change them:
{{elements}}

Observed state transitions (act→observe). GROUND state-transition assertions ON THESE — do not invent consequences:
{{transitions}}

Domain knowledge (credentials, validation rules, nuances — account for these in the cases):
{{knowledge}}

{{experience}}

{{style}}

{{methodology}}

{{checklist}}

Generate clear, verifiable test cases. For each:
- title — concise title;
- technique — applied 29119-4 technique;
- kind — "static" (visibility/state check only, no actions) or "active" (with actions: click/fill/navigation);
- type — "Positive" (valid scenario) or "Negative" (invalid/erroneous input);
- execution — "auto" (can be RELIABLY automated: read-only checks on verified locators) or "manual" (full generation/submit, security/XSS, UI-UX/visual/responsiveness, irreversible actions — the bot does NOT automate these);
- preconditions — preconditions (e.g. "user is logged in", "page X is open");
- steps — DETAILED unambiguous steps with REAL element labels (e.g. 'Click "Generate CV"', 'Enter text into the "Vacancy text" field');
- expected — verifiable expected result;
- priority — critical | high | medium | low;
- elementRefs — real refs from the list above that the case touches.

ASSERTION SAFETY:
- Read-only by default: check visibility/state (toBeVisible/toBeEnabled/toBeChecked), not the consequences of actions.
- For destructive/irreversible controls (Delete, Remove, Submit, Convert, Log out, Add — anything that writes data or signs out) — only check that the element is VISIBLE; do NOT click or perform the action.

STABILITY (CRITICAL):
- One case = ONE logical check (one expected). Do NOT combine many assertions in one case — a mega-test fails entirely if any single part is off.
- Each case is INDEPENDENT and starts from a CLEAN page. Do NOT assume state left by another case.
- Do NOT generate contradictory cases (e.g. one expects toggle=on, another toggle=off from a fresh start). For a toggle take EXACTLY ONE transition from the "Observed state transitions" (before→after).

Cover happy path AND negative/edge scenarios. No duplicates or trivialities.

FULL CHECKLIST COVERAGE: do NOT skip checklist items. If an item cannot be reliably automated (full generation/submit flow, security/XSS, UI-UX/visual/responsiveness, irreversible actions) — STILL create a case, but set execution="manual" (it will not be automated, but it is documented for manual testing). Every checklist item → at least one case (auto or manual).`;
