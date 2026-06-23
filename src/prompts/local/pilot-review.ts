/** Pilot supervisor prompt (idea from explorbot): holistic run verdict. */
export const PILOT_REVIEW = `You are the Pilot supervisor of a QA run. Review the result and issue a holistic verdict.

Page: {{pageSemantics}}
Validation: {{validation}}
Test cases:
{{cases}}

Return:
- verdict: "pass" (run is sufficient and high-quality) | "needs-work" (gaps exist but not critical) | "fail" (serious problems);
- reason: ONE sentence — the main basis for the verdict;
- guidance: ONE concrete next step to improve;
- entity: the NAME of the entity this run created or edited (e.g. the record/item title), or "" if the run was read-only and created nothing. Do NOT invent a name — use only what the cases above actually reference.`;
