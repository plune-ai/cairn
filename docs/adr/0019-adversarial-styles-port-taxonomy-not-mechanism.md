# ADR-0019: Adversarial styles — port the taxonomy, not the mechanism

- **Status:** Accepted
- **Date:** 2026-07-01
- **Decision in code:** `src/api/adversarial.ts`, `src/api/cases.ts`, `src/api/runner.ts`, `src/core/modalities/api.ts`
- **Applies from:** 0.6.0 · **Issues:** #95 (BORROW-07), #96 (BORROW-08) · **PR:** #153
- **Relationship to prior ADRs:** the same move as ADR-0008 (port a methodology, not an implementation), applied to an adjacent tool instead of the author's own skill library. Stays inside ADR-0015's no-LLM discipline.

## Context

`testomatio/explorbot` frames adversarial exploration as four named personas — **normal**, **curious**,
**psycho**, **hacker** — which is a genuinely good taxonomy. It gives a user one word for a cost/risk
posture, and it maps onto how testers actually talk about coverage.

The implementation behind those names does not port. Explorbot's styles are **LLM-driven**: the persona is a
prompt, and the model decides what a "psycho" input looks like on this endpoint. There is no deterministic
style→value mapping to lift. Copying the mechanism would have meant putting an LLM call back into the middle
of a generator that ADR-0015 had just established as pure — losing determinism and reproducible identities
(ADR-0014) to buy a naming scheme.

Separately, `AZANIR/qa-skills` (the same source ADR-0008 ported the web methodology from) already carries a
payload library indexed by **OWASP WSTG** test IDs. That is the deterministic half the taxonomy was missing.

## Decision

**Take the four names from explorbot, and fill them from the schema and the WSTG payload library —
deterministically, with no LLM call.** `--adversarial [styles]` on `cairn api`.

| Style | What it deterministically produces |
|---|---|
| `normal` | the always-generated happy path (API-2), **tagged in place** — no new case is minted |
| `curious` | exhaustive *valid* coverage: a case with every param including optional ones, plus one case per additional `enum` value |
| `psycho` | SQL-injection and XSS payloads (`WSTG-INPV-05`, `WSTG-INPV-01`) plus a boundary-numeric case on the first suitable body property, and API-8's existing negative case **re-tagged rather than reimplemented** |
| `hacker` | the deterministic subset only: strip auth from an otherwise-valid request and expect rejection |

Supporting rules:

1. **One flat case list.** Adversarial cases fold into the same list as `--negative`, with an
   `adversarialStyle` tag and a `wstgId` where a specific WSTG test applies. There is **no parallel reporting
   layer** — coverage, the report and the ATC artifacts (ADR-0015) handle them unchanged. API-6's
   `computeApiCoverage` needed no new code at all: it is endpoint/status-driven already.
2. **Reuse over re-derivation.** `psycho` re-tags the existing negative case instead of minting a duplicate;
   `normal` tags the base case rather than re-emitting it.
3. **The scope cut is explicit.** `hacker`'s IDOR and privilege-escalation checks are **not** shipped. In
   explorbot they are stateful and multi-request — two identities, resource chaining, response-field replay —
   which is API-9 scenario-chain machinery, not a single case. Only the deterministic single-request
   auth-strip check ships here.
4. **An unrecognised style name generates nothing**, and says so. It does not silently fall back to running
   every style.

### What self-review caught before this shipped

Worth recording, because all three are the failure mode this design invites — derived cases inheriting the
wrong metadata from the case they were derived from:

- new `psycho`/`hacker` cases were inheriting `type: "Positive"` from their happy-path base, though they
  expect rejection;
- a reused negative case's name collided with the plain `--negative` version when both flags were passed;
- `--adversarial` with an unknown style silently ran *every* style instead of none.

All three were fixed with regression coverage and a live CLI run confirming each.

## Consequences

- **The names are borrowed; the behaviour is ours.** A user coming from explorbot recognises the vocabulary
  and gets different, more predictable output: same spec plus same styles ⇒ same cases, every run.
- **Security cases carry a standard reference.** A `wstgId` makes a generated case traceable to OWASP WSTG,
  which is what makes it defensible in a review rather than "the tool made this up".
- **The ceiling is deterministic payloads.** These cases find the classes of bug a fixed payload finds. They
  are not a fuzzer and not a pentest, and the WSTG tag should not be read as coverage of that WSTG item.
- **`hacker` is honestly incomplete.** The auth-strip check is a real check; IDOR and privilege escalation are
  the interesting half and remain unbuilt. Building them means building on API-9, not on this module.
- **No LLM cost is added to `api` runs**, so ADR-0015's determinism and ADR-0014's `stableId` guarantees hold
  for adversarial cases too.

## Rejected alternatives

- **Port explorbot's LLM-driven styles as prompts.** Would have reintroduced non-determinism and per-operation
  token cost into a generator deliberately built without them, and made `stableId` unstable for these cases.
- **A parallel adversarial report section.** Duplicates coverage, reporting and artifact code for cases that
  are ordinary cases with an extra tag.
- **Skip the taxonomy and expose flags like `--sqli --xss --no-auth`.** Loses the one thing worth borrowing:
  a single word for a posture that a user can reason about without knowing the payload catalogue.
- **Ship `hacker` with an LLM-driven IDOR attempt.** The stateful part is real work with real
  false-positive risk; shipping a plausible-looking version of it would be worse than not shipping it.
