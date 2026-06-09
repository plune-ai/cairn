# ADR-0005: Output format — @playwright/test (POM + getByRole + ARIA assertions)

- **Status:** Accepted
- **Date:** 2026-06-08
- **Decision in code:** `src/codegen/`, `prompts/local/qa-playwright-ts-writer.md`

## Context

The bot must generate UI tests that will go into the working project. The format must match the project's stack,
be modern, stable, and **self-validating** (the bot must be able to run and check the output itself).

## Decision

The output is **`@playwright/test`** with the following conventions:

- **Page Object Model + fixtures** (`test.extend`) for reuse.
- **User-facing locators** prioritized: `getByRole` > `getByLabel` > `getByText` > `getByTestId`;
  CSS/XPath — only as a last resort (penalized by the `locator_quality` scorer).
- **ARIA snapshot assertions** (`toMatchAriaSnapshot`) with `*.aria.yml` sidecar files — structural regression.
- The generated suite must parse with `tsc` and be runnable via the PRIMARY backend (`runTests`).

## Why this matches the rest

The exploration driver (playwright-lib) and the output format are the same library → `getByRole` locators
map directly to the roles from the `ariaSnapshot()` the bot already captured. Minimal impedance.

## Consequences

- (+) Tests are validated immediately by the same engine that "saw" them.
- (+) `getByRole` from the snapshot = stable, maintainable locators.
- (−) `.aria.yml` is a sidecar: the emitter and ArtifactStore must treat a spec + its `.aria.yml` as a unit.
- (−) Coupling to Playwright; other frameworks (Cypress/WDIO) are separate generators in the future (qa-skills has them).

## Rejected alternatives

- **Cypress / WebdriverIO** — valid, but don't match the chosen driver; would add an exploration↔output seam.
- **Text-only test cases without code** — half a product; the code is the main value.
