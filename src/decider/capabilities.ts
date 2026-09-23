import { DeciderUnavailable, type DeciderCaps, type DeciderProvider, type Question } from "./types.js";

/**
 * What each provider can answer faithfully (ADR-0022). Measured for laya 0.3.11 rather than taken from
 * its model card: the `english` checkpoint reads 512 tokens, `multilingual` 1024 (~3.9 chars per token
 * for English, ~2.5 for Ukrainian), and an over-long state is TRUNCATED SILENTLY — the server still
 * answers, from the part it read. So the cap is enforced here, before the request, never by the server.
 * `compat` is an unknown server: it gets laya's conservative caps (a small cap only costs fallbacks).
 */
export const CAPS: Record<DeciderProvider, DeciderCaps> = {
  // Jev: 32k tokens for state + the longest question (docs.typesafe.ai/models) — 60k chars stays inside.
  jev: { maxStateChars: 60_000, maxOptions: 255, maxQuestionsPerCall: 64, price: { inputPer1M: 0.042, outputPer1M: 0 } },
  // ponytail: one cap for both laya checkpoints (the 512-token english one binds); split per checkpoint if the pilot needs room.
  laya: { maxStateChars: 1_200, maxOptions: 20, maxQuestionsPerCall: 16, price: { inputPer1M: 0, outputPer1M: 0 } },
  compat: { maxStateChars: 1_200, maxOptions: 20, maxQuestionsPerCall: 16 },
};

/** Throws DeciderUnavailable for a request the provider cannot answer faithfully — before any network call. */
export function checkCaps(caps: DeciderCaps, state: string, questions: Record<string, Question>): void {
  const n = Object.keys(questions).length;
  if (n === 0) throw new DeciderUnavailable("no questions");
  if (n > caps.maxQuestionsPerCall) throw new DeciderUnavailable(`${n} questions > ${caps.maxQuestionsPerCall} per call`);
  if (state.length > caps.maxStateChars) {
    throw new DeciderUnavailable(`state is ${state.length} chars > ${caps.maxStateChars}`);
  }
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const k = Object.keys(q.options).length;
      if (k < 2 || k > caps.maxOptions) {
        throw new DeciderUnavailable(`question '${key}': ${k} options (allowed 2..${caps.maxOptions})`);
      }
    } else if (q.type === "score" && (q.levels.length < 2 || q.levels.length > 10)) {
      throw new DeciderUnavailable(`question '${key}': ${q.levels.length} levels (allowed 2..10)`);
    }
  }
}
