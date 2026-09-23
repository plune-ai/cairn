import { DeciderUnavailable, type DeciderCaps, type DeciderProvider, type Question } from "./types.js";

/**
 * What each provider can answer faithfully (ADR-0022). Measured for laya 0.3.11 rather than taken from its
 * model card. laya encodes every question on its own as `[question + options] [state]`: the question part is
 * cut at 192 tokens (each option at 48), the state gets what is left of 512 tokens (`english`) or 1024
 * (`multilingual`) — ~3.9 chars per token of English, ~2.5 of Ukrainian — and BOTH cuts are silent: the server
 * still answers, from the part it read. So the limits are enforced here, before the request, never by the
 * server. `compat` is an unknown server: it gets laya's conservative caps (a small cap only costs fallbacks).
 */
export const CAPS: Record<DeciderProvider, DeciderCaps> = {
  // Jev: 32k tokens for the state + the longest question (docs.typesafe.ai/models) — 60k chars stays inside.
  jev: {
    maxInputChars: 60_000,
    maxQuestionChars: 60_000,
    maxOptions: 255,
    maxQuestionsPerCall: 64,
    price: { inputPer1M: 0.042, outputPer1M: 0 },
  },
  // 1 200 chars stay under 512 tokens even at 2.5 chars/token; a 400-char question under its 192-token part.
  // ponytail: one cap for both laya checkpoints (the 512-token english one binds); split per checkpoint if the pilot needs room.
  laya: { maxInputChars: 1_200, maxQuestionChars: 400, maxOptions: 20, maxQuestionsPerCall: 16, price: { inputPer1M: 0, outputPer1M: 0 } },
  compat: { maxInputChars: 1_200, maxQuestionChars: 400, maxOptions: 20, maxQuestionsPerCall: 16 },
};

/** The text a question adds to the model's input: instructions plus every option's label and description. */
export function questionChars(q: Question): number {
  switch (q.type) {
    case "noul":
      return q.instructions.length + q.criteria.true.length + q.criteria.false.length;
    case "choice":
      return Object.entries(q.options).reduce((n, [label, d]) => n + label.length + (d?.length ?? 0), q.instructions.length);
    case "score":
      return q.levels.reduce((n, l) => n + l.length, q.instructions.length);
  }
}

/** Throws DeciderUnavailable for a request the provider cannot answer faithfully — before any network call. */
export function checkCaps(caps: DeciderCaps, state: string, questions: Record<string, Question>): void {
  const n = Object.keys(questions).length;
  if (n === 0) throw new DeciderUnavailable("no questions");
  if (n > caps.maxQuestionsPerCall) throw new DeciderUnavailable(`${n} questions > ${caps.maxQuestionsPerCall} per call`);
  let longest = 0;
  for (const [key, q] of Object.entries(questions)) {
    const chars = questionChars(q);
    if (chars > caps.maxQuestionChars) throw new DeciderUnavailable(`question '${key}' is ${chars} chars > ${caps.maxQuestionChars}`);
    longest = Math.max(longest, chars);
    if (q.type === "choice") {
      const k = Object.keys(q.options).length;
      if (k < 2 || k > caps.maxOptions) {
        throw new DeciderUnavailable(`question '${key}': ${k} options (allowed 2..${caps.maxOptions})`);
      }
    } else if (q.type === "score" && (q.levels.length < 2 || q.levels.length > 10)) {
      throw new DeciderUnavailable(`question '${key}': ${q.levels.length} levels (allowed 2..10)`);
    }
  }
  const input = state.length + longest;
  if (input > caps.maxInputChars) {
    throw new DeciderUnavailable(`input is ${input} chars (state ${state.length} + question ${longest}) > ${caps.maxInputChars}`);
  }
}
