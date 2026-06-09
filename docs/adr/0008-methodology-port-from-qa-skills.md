# ADR-0008: The methodology is ported from AZANIR/qa-skills

- **Status:** Accepted
- **Date:** 2026-06-08
- **Decision in code:** `prompts/local/qa-*.md`, the specs in `docs/prompts/`

## Context

The "skill based on testing postulates" already exists in the author's own repository **`AZANIR/qa-skills`**
(npm `qa-skills`, ~57 skills, ISO/IEC/IEEE 29119-4, POM codegen). There's no point reinventing the methodology from scratch.

## Decision

**Port** the relevant skills into the bot's versioned Langfuse prompts (ADR-0004):

| qa-skills skill | Bot prompt | Role |
|----------------|-------------|------|
| `qa-testcase-from-ui` | `qa-testcase-from-ui` | cases from a screenshot/snapshot |
| `qa-manual-test-designer` | `qa-manual-test-designer` | 29119-4 techniques |
| `qa-playwright-ts-writer` | `qa-playwright-ts-writer` | POM codegen Playwright/TS |

The port = adapting the methodological **content** to an autonomous runtime + structured output, not a copy of SKILL.md.
The specifications of each prompt are in `docs/prompts/`.

## License / provenance

`qa-skills` is **GPL-3.0**. **The user (AZANIR / eleoneks) is the author of the repository**, so as the
copyright holder they are not constrained by GPL in using their own material (including in a closed working project).
We still record provenance and attribution in the prompt specifications (`docs/prompts/*`) so the origin is transparent.

## Consequences

- (+) We start from a validated, structured methodology instead of "from scratch".
- (+) Consistency with the user's familiar approach (Chain 2: browser → UI cases → tests).
- (−) The GPL origin requires care if third parties join the working project → keep the attribution.
- (−) The skills were written for human-invoked agents (Cursor/Claude) → adaptation to an autonomous structured-output runtime is needed.

## Rejected alternatives

- **Writing prompts from scratch** — duplicating work already done, with a risk of a worse methodology.
- **Installing the qa-skills package and wrapping it as-is** — coupling to the GPL skill format, less control over
  self-improvement (the prompts must be "ours" in Langfuse).
