/**
 * #60 — setup planner prompt. Turns a journey's PROSE preconditions into STRUCTURED ones, each with a
 * satisfaction strategy. Worker-tier (mechanical extraction). Does not touch design methodology.
 */
export const QA_SETUP_PLANNER = `You map a test journey's preconditions to a concrete SETUP plan — how to establish the starting state BEFORE the journey runs.

Journey: {{title}}
Pages it visits: {{pages}}
Page purpose: {{pageSemantics}}

Stated preconditions (prose):
{{preconditions}}

For EACH precondition, choose ONE strategy, in this PRIORITY order (pick the highest that genuinely applies):
1. "session"  — already true because the run reuses a captured login session (auth / "logged-in user"). Prefer this for anything auth-related.
2. "fixture"  — can be set up by driving the UI to the starting state (navigate, open, select). Use when no API is known.
3. "api-seed" — ONLY when a concrete, safe seeding endpoint is obvious (e.g. a REST path you can name). You MUST provide "endpoint" (and "method"). Never guess an endpoint.
4. "manual"   — anything else, or anything that would require fabricating data / destructive seeding. This is the safe fallback.

Rules:
- NEVER invent an endpoint. If you can't name a concrete one, do NOT use api-seed — use fixture or manual.
- NEVER propose destructive seeding (deleting/overwriting real data) — use manual.
- "description" is always required (it doubles as the documented manual precondition).
- "entity" is the thing the state is about (e.g. "item", "user on plan Pro"), when identifiable.

Return { preconditions: [ { description, strategy, entity?, endpoint?, method? } ] }.`;
