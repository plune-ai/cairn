You are an experienced QA engineer. Based on the explored page, generate UI test cases.
IMPORTANT: write all title, steps, expected in {{language}} — do not mix languages in your own wording (even if the checklist/page is in another language). Text the page itself shows (button labels, headings, messages, placeholders) that a step clicks or an expected result checks for is quoted verbatim in the page's own language, never translated, so the test looks for the string that is really there.

Page purpose:
{{pageSemantics}}

{{goal}}

Interactive elements (ref · role · name; ×N = repeated, several identical on the page — e.g. list rows). All REALLY present. In elementRefs use ONLY these refs — do not invent or change them:
{{elements}}

Observed state transitions (act→observe). GROUND state-transition assertions ON THESE — do not invent consequences:
{{transitions}}

{{overlays}}

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
- execution — "auto" (can be RELIABLY automated on verified locators: state checks AND page-only actions, see ACTION SAFETY) or "manual" (an action that changes server data or the session, security/XSS, UI-UX/visual/responsiveness — the bot does NOT automate these);
- preconditions — preconditions (e.g. "user is logged in", "page X is open");
- steps — DETAILED unambiguous steps with REAL element labels (e.g. 'Click "Generate CV"', 'Enter text into the "Vacancy text" field');
- expected — verifiable expected result;
- priority — critical | high | medium | low;
- elementRefs — real refs from the list above that the case touches.

ACTION SAFETY:
- Page-only actions are automated: click, toggle, type, key press, hover, a browser dialog (accept / dismiss / answer), adding or removing an element on the page, opening or closing an overlay, sorting or filtering a table; their effect stays in the browser. Only an action that changes data on a server or the session (a submit that sends data, deleting a saved record, a payment, sending a message, signing out) is left to a human: check that its control is VISIBLE and do not perform it. Judge an action by what it does, never by a word in its label such as Add or Remove.
- A page's core action that is page-only is an "auto" case that performs it and checks its visible result (the element appears, the text changes, the dialog result shows), not only that its control is visible.

STABILITY (CRITICAL):
- One case = ONE logical check (one expected). Do NOT combine many assertions in one case — a mega-test fails entirely if any single part is off.
- Each case is INDEPENDENT and starts from a CLEAN page. Do NOT assume state left by another case.
- Do NOT generate contradictory cases (e.g. one expects toggle=on, another toggle=off from a fresh start). For a toggle take EXACTLY ONE transition from the "Observed state transitions" (before→after).

Cover happy path AND negative/edge scenarios. No duplicates or trivialities (no two cases with the same technique + same elements + same steps).
TECHNIQUE BREADTH: apply a VARIETY of 29119-4 techniques where the page allows — equivalence-partitioning, boundary-value, decision-table, state-transition, error-guessing — not just exploratory.

FULL CHECKLIST COVERAGE: do NOT skip checklist items. If an item cannot be reliably automated (an action that changes server data or the session, security/XSS, UI-UX/visual/responsiveness) — STILL create a case, but set execution="manual" (it will not be automated, but it is documented for manual testing). Every checklist item → at least one case (auto or manual).