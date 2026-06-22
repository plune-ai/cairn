/**
 * #82 — design-time self-critique prompt. A SEPARATE, cheap worker-tier pass that reviews the
 * first design set: it PRUNES weak cases and TOPS UP under-represented techniques. It does NOT
 * redesign and does NOT touch the methodology / assertion-safety rules — those live in
 * `qa-testcase-from-ui` and `qa-manual-test-designer` and stay fixed.
 */
export const QA_CASE_CRITIQUE = `You are a senior QA reviewer doing a SECOND pass over an already-designed set of UI test cases.
Write everything (titles, steps, expected) in {{language}} — do not mix languages.

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
   - read-only by default — for destructive/irreversible controls only check visibility, never perform the action;
   - real element labels in steps; elementRefs taken ONLY from the refs listed above.
   Add nothing if the techniques cannot be honestly covered — an empty top-up is a valid answer.

Each new case has: title, technique (one of the under-represented ones), kind ("static"|"active"),
type ("Positive"|"Negative"), execution ("auto"|"manual"), preconditions, steps, expected, priority, elementRefs.`;
