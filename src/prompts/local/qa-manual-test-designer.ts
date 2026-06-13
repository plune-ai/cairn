/**
 * Methodology block for test-case design (ISO/IEC/IEEE 29119-4).
 * Provenance: ported from AZANIR/qa-skills → `qa-manual-test-designer` (authored by the maintainer; included here under Apache-2.0). ADR-0008.
 * Mixed into `qa-testcase-from-ui` via the {{methodology}} variable.
 */
export const QA_MANUAL_TEST_DESIGNER = `Apply ISO/IEC/IEEE 29119-4 test design techniques where appropriate:
- Equivalence Partitioning — equivalence classes for input fields (valid/invalid).
- Boundary Value Analysis — boundaries of ranges, lengths, dates, numeric limits.
- Decision Table — combinations of conditions (access rights, flags, modes).
- State Transition — wizards, modal dialogs, status transitions.
- Error Guessing / Exploratory — common defects, negative and edge scenarios.
Prioritize cases by risk: critical | high | medium | low.`;
