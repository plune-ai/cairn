/**
 * The decision layer's contract (ADR-0022). A System One model — TypeSafe Jev, Convai Laya, or any
 * server speaking Jev's `POST /v1/systemone` — answers typed questions about a state; it never writes
 * text. These are Cairn's own types: the wire format differs on purpose, and `client-http.ts` is the
 * only place that knows it.
 */
export const DECIDER_PROVIDERS = ["jev", "laya", "compat"] as const;
export type DeciderProvider = (typeof DECIDER_PROVIDERS)[number];

/** Use points `DECIDER_USES` accepts — nothing else (a typo must not look enabled). */
export const DECIDER_USES = ["repair-triage", "coverage"] as const;
export type DeciderUse = (typeof DECIDER_USES)[number];

export type Question =
  | {
      type: "noul";
      instructions: string;
      /**
       * What a yes and a no mean. Required: measured on laya 0.3.11, a bare yes/no is answered against
       * the text, and these descriptions are what laya's two-option form is asked with (client-http.ts).
       */
      criteria: { true: string; false: string };
    }
  | {
      type: "choice";
      instructions: string;
      /** label → when it applies (null = the label speaks for itself). The answer is one of these labels. */
      options: Record<string, string | null>;
    }
  | {
      type: "score";
      instructions: string;
      /** Ordered level descriptions; the answer's value is a position between 0 and levels.length − 1. */
      levels: string[];
    };

/**
 * `confidence` describes the SHAPE of the answer's distribution, not the chance it is right, and each
 * provider computes it differently — thresholds are calibrated per use and per provider (spec §8.4, §9.5).
 */
export type Answer =
  | { type: "noul"; value: boolean; p: number; confidence: number }
  | { type: "choice"; value: string; dist: Record<string, number>; confidence: number }
  | { type: "score"; value: number; dist: number[]; confidence: number };

export interface DeciderCaps {
  /** State + its longest question, in characters: each question is encoded together with the state. */
  maxInputChars: number;
  /** One question's own text (instructions + options): laya cuts that part of its input separately. */
  maxQuestionChars: number;
  /** One option as laya renders it (`label: description`, a criterion, a level): laya cuts each at 48 tokens. */
  maxOptionChars: number;
  maxOptions: number;
  maxQuestionsPerCall: number;
  /** USD per 1M tokens; undefined → unknown, the cost line shows n/a. */
  price?: { inputPer1M: number; outputPer1M: number };
}

/** Parsed `DECIDER*` configuration (config/index.ts). Absent from AppConfig unless a provider is chosen. */
export interface DeciderConfig {
  provider: DeciderProvider;
  baseUrl: string;
  model: string;
  /** jev: TYPESAFE_API_KEY · laya: LAYA_API_KEY · compat: DECIDER_API_KEY — never another provider's key. */
  apiKey?: string;
  uses: DeciderUse[];
  minConfidence: number;
  timeoutMs: number;
  maxCalls: number;
}

export interface Decider {
  readonly provider: DeciderProvider;
  readonly model: string;
  readonly caps: DeciderCaps;
  readonly uses: ReadonlySet<DeciderUse>;
  readonly minConfidence: number;
  /** The questions are independent: they share `state` and never see each other's answers. */
  decide<K extends string>(use: DeciderUse, state: string, questions: Record<K, Question>): Promise<Record<K, Answer>>;
}

/** Any failure or limit. The call site catches it and takes the path it would have taken without a decider. */
export class DeciderUnavailable extends Error {
  constructor(
    message: string,
    /** HTTP status when the server answered with an error — lets the guard retry 429/5xx once. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "DeciderUnavailable";
  }
}
