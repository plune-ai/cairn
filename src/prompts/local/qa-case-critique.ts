/**
 * #82 — design-time self-critique prompt. A SEPARATE, cheap worker-tier pass that reviews the
 * first design set: it PRUNES weak cases and TOPS UP under-represented techniques. It does NOT
 * redesign and does NOT touch the methodology / assertion-safety rules — those live in
 * `qa-testcase-from-ui` and `qa-manual-test-designer` and stay fixed.
 */
export const QA_CASE_CRITIQUE = `You are a senior QA reviewer doing a SECOND pass over an already-designed set of UI test cases.
Write everything (titles, steps, expected) in {{language}} — do not mix languages in your own wording. Text the page itself shows (button labels, headings, messages, placeholders) that a step clicks or an expected result checks for is quoted verbatim in the page's own language, never translated, so the test looks for the string that is really there.

Current test cases (id · [technique/type] · title → expected):
{{cases}}

Under-represented 29119-4 techniques on this page (cover these if the page genuinely supports them — do NOT invent cases the page can't back):
{{underrepresented}}

Real element refs you may reference (use ONLY these — never invent refs):
{{elements}}

Do TWO things:
1. PRUNE — list the ids of cases to DROP, each with a one-line reason. Drop a case ONLY if it is:
   - trivial (asserts nothing meaningful, e.g. "page loads"),
   - contradictory with another case (e.g. two cases expect opposite states of the same toggle from a clean start), or
   - not verifiable (its "expected" cannot be objectively checked).
   When in doubt, KEEP the case — pruning is conservative.
2. TOP UP — add NEW cases ONLY for the under-represented techniques above, where the page supports them.
   Each new case follows the SAME rules as the original design:
   - one logical check (one expected), independent, starting from a clean page;
   - Page-only actions are automated: click, toggle, type, key press, hover, a browser dialog (accept / dismiss / answer), adding or removing an element on the page, opening or closing an overlay, sorting or filtering a table; their effect stays in the browser. Only an action that changes data on a server or the session (a submit that sends data, deleting a saved record, a payment, sending a message, signing out) is left to a human: check that its control is VISIBLE and do not perform it. Judge an action by what it does, never by a word in its label such as Add or Remove.;
   - real element labels in steps; elementRefs taken ONLY from the refs listed above.
   Add nothing if the techniques cannot be honestly covered — an empty top-up is a valid answer.

Each new case has: title, technique (one of the under-represented ones), kind ("static"|"active"),
type ("Positive"|"Negative"), execution ("auto"|"manual"), preconditions, steps, expected, priority, elementRefs.`;
