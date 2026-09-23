import { z } from "zod";
import { DeciderUnavailable, type Answer, type DeciderProvider, type Question } from "./types.js";

/**
 * The ONE HTTP client for every provider (ADR-0022): Jev's `POST /v1/systemone`, which laya-serve and
 * any "compat" server also speak. The wire format — checked against the official SDK (typesafe_sdk
 * 0.7.1) and docs.typesafe.ai/api, not guessed — is known only to this file.
 */
export interface HttpTarget {
  provider: DeciderProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface SystemOneResult<K extends string> {
  answers: Record<K, Answer>;
  /** Token usage when the server reports it (Jev and laya both do). */
  usage?: { inputTokens: number; outputTokens: number };
  /** The model that answered (Jev reports the versioned id, e.g. jev-1.13.0). */
  model?: string;
}

/**
 * laya 0.3.11 answers a `noul` against the text on some phrasings, with p = 0.89–0.94 on the wrong side
 * (a confident error passes any threshold). Asked as a two-option choice built from the SAME criteria,
 * its errors come with low confidence, which the threshold turns into a fallback. Measured, see ADR-0022.
 */
const NOUL_AS_CHOICE: ReadonlySet<DeciderProvider> = new Set(["laya"]);

/** Confidence of a yes/no: 0 at a coin flip, 1 at certainty — the two-option form of Jev's choice statistic. Jev returns none for noul. */
export function noulConfidence(p: number): number {
  return Math.abs(2 * p - 1);
}

function toWire(provider: DeciderProvider, q: Question): Record<string, unknown> {
  switch (q.type) {
    case "noul":
      return NOUL_AS_CHOICE.has(provider)
        ? { type: "choice", instructions: q.instructions, criteria: { a: q.criteria.true, b: q.criteria.false } }
        : { type: "noul", instructions: q.instructions, criteria: q.criteria };
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: q.options };
    case "score":
      return { type: "score", instructions: q.instructions, criteria: q.levels };
  }
}

const Prob = z.number().min(0).max(1);
const WireBody = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({ input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional() })
    .optional(),
});
const WireNoul = z.object({ type: z.literal("noul"), noul: Prob });
const WireChoice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), Prob),
  confidence: Prob,
});
const WireScore = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), Prob),
  confidence: Prob,
});

/** One wire answer, checked against the question it answers. The answer is untrusted input (ADR-0020). */
function fromWire(provider: DeciderProvider, key: string, q: Question, raw: unknown): Answer {
  const bad = (why: string): never => {
    throw new DeciderUnavailable(`invalid answer '${key}': ${why}`);
  };
  if (q.type === "noul" && NOUL_AS_CHOICE.has(provider)) {
    const a = WireChoice.safeParse(raw);
    const p = a.success ? a.data.probabilities.a : undefined;
    if (p === undefined) return bad("expected the two-option choice with option 'a'");
    return { type: "noul", value: p >= 0.5, p, confidence: noulConfidence(p) };
  }
  switch (q.type) {
    case "noul": {
      const a = WireNoul.safeParse(raw);
      if (!a.success) return bad("expected a noul probability");
      return { type: "noul", value: a.data.noul >= 0.5, p: a.data.noul, confidence: noulConfidence(a.data.noul) };
    }
    case "choice": {
      const a = WireChoice.safeParse(raw);
      if (!a.success) return bad("expected a choice");
      if (!Object.hasOwn(q.options, a.data.choice)) return bad(`'${a.data.choice}' was not one of the offered options`);
      return { type: "choice", value: a.data.choice, dist: a.data.probabilities, confidence: a.data.confidence };
    }
    case "score": {
      const a = WireScore.safeParse(raw);
      if (!a.success) return bad("expected a score");
      if (a.data.score < 0 || a.data.score > q.levels.length - 1) return bad("score outside the levels");
      const dist = q.levels.map((_, i) => a.data.probabilities[String(i)] ?? 0);
      return { type: "score", value: a.data.score, dist, confidence: a.data.confidence };
    }
  }
}

/** One `POST /v1/systemone`. Anything but a complete, valid answer set → DeciderUnavailable (`status` set on an HTTP error). */
export async function postSystemOne<K extends string>(
  target: HttpTarget,
  state: string,
  questions: Record<K, Question>,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<SystemOneResult<K>> {
  const entries = Object.entries(questions) as [K, Question][];
  const wire = Object.fromEntries(entries.map(([k, q]) => [k, toWire(target.provider, q)]));
  let res: Response;
  try {
    res = await fetchFn(`${target.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({ state, model: target.model, questions: wire }),
      signal,
    });
  } catch (e) {
    throw new DeciderUnavailable(`request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new DeciderUnavailable(`HTTP ${res.status}`, res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new DeciderUnavailable("the response is not JSON");
  }
  const body = WireBody.safeParse(json);
  if (!body.success) throw new DeciderUnavailable("the response is not a /v1/systemone answer set");
  const answers = {} as Record<K, Answer>;
  for (const [k, q] of entries) {
    if (!Object.hasOwn(body.data.answers, k)) throw new DeciderUnavailable(`missing answer '${k}'`);
    answers[k] = fromWire(target.provider, k, q, body.data.answers[k]);
  }
  const u = body.data.usage;
  return {
    answers,
    ...(body.data.model ? { model: body.data.model } : {}),
    ...(u?.input_tokens !== undefined ? { usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens ?? 0 } } : {}),
  };
}
