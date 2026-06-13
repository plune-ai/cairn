# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-14

### Added

- Per-role model routing (`worker`/`reasoner`) with `LLM_ROUTING` presets `volume` (OpenRouter) and `fast` (Groq), plus `CAIRN_ROLE_*` overrides; per-run, per-role cost & token reporting in `report.md` / `report.json` / the CLI. (#6, #7)
- Groq provider. (#7)
- Reproducible cost benchmark via `npm run bench`. (#8)
- First-class session management — `cairn session capture | ls | rm` (and the `cairn login` alias) — with missing/expired-session UX. (#27)

### Changed

- License: relicensed from GPL-3.0-only to Apache-2.0 (permissive; patent grant). See ADR-0012.
- `cairn explore` hardening: graceful browser/observe error handling, repair-loop no-progress convergence, `CallBudget` usage surfaced in the output, and a clearer first-run summary. (#26)
- Pilot verdict now runs on the strong `reasoner` role (was the cheap `judge` tier). (#6)
- The decoupled `design → automate` flow now runs the same validate⇄repair⇄keep-best loop as `explore`, and `explore` now also emits ATC/MTC case files to `testcases/`. (#39, #40)

> **Backward compatibility:** `LLM_PROFILE` and existing configs are unchanged — per-role routing, cost reporting, and the new session commands are additive and opt-in.

[0.3.0]: https://github.com/plune-ai/cairn/compare/v0.2.1...v0.3.0
