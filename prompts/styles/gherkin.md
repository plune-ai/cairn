STYLE FOR THIS RUN — GHERKIN STEP FORMAT.
This affects ONLY naming, format, language, and tone. It does NOT change which 29119-4 techniques
are applied, how many cases are produced, or the assertion-safety / stability rules.

- Write the steps in Given / When / Then form:
  - **Given** … — preconditions / starting state (a clean page).
  - **When** … — the single action under test.
  - **Then** … — the observable, checkable outcome.
- One **When** per case (one logical action); fold any setup into **Given** and the assertion into **Then**.
- Titles stay plain prose (not Gherkin).

Keep the same set of cases and the same technique coverage; only reshape the step phrasing.
