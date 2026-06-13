/**
 * C1-01 — shared core: the `Modality` type + its supporting IO and the gated-stub notice.
 *
 * A "modality" is one kind of test artifact Cairn can generate (UI/API/unit/docs…). Today only
 * `explore` (UI) is REAL; the rest are GATED stubs (L-G2 / #25): discoverable placeholders with
 * ZERO generation logic. A future modality is a thin add — register an entry and give it a `run`
 * that consumes the shared core — not a fork of the whole CLI.
 */

/** Sink for one chunk of CLI output (stdout or stderr). */
export type Sink = (s: string) => void;

/** The stdout/stderr sinks a modality writes through — injected in tests, real streams in the CLI. */
export interface IO {
  out: Sink;
  err: Sink;
}

/** Default IO → the process streams (the production CLI path). */
export const defaultIO: IO = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
};

/** Everything a modality's `run` needs: the parsed CLI flags + output sinks. */
export interface ModalityContext {
  /** Parsed commander options for this modality's command. */
  flags: Record<string, unknown>;
  out: Sink;
  err: Sink;
}

/**
 * One generation modality. `run` is ABSENT for gated stubs — that absence IS the gate: a stub
 * carries no runner, so it can never trigger generation. The real `explore` modality supplies a
 * `run` that wraps {@link runExploration} + the shared render/cost/summary helpers.
 */
export interface Modality {
  /** Command name as typed: `cairn <name>`. */
  name: string;
  /** Extra command aliases (e.g. ui ⇄ e2e). */
  aliases?: string[];
  /** Gated = coming-soon placeholder; built one at a time, by named demand (L-G2). */
  gated: boolean;
  /** One-line description shown in `cairn --help`. */
  summary: string;
  /** Optional extra line appended to the gated notice (e.g. ui → points at `cairn explore`). */
  hint?: string;
  /** Run the modality. Absent for gated stubs. */
  run?(ctx: ModalityContext): Promise<void>;
}

/**
 * The notice printed when a user runs a gated modality. Pure (returns lines, like
 * {@link renderRunSummary}) so it is trivially testable: the canonical one-liner + the optional hint.
 */
export function gatedNotice(m: Modality): string[] {
  const lines = [`${m.name}: coming soon — gated (see L-G2). Build by demand, one at a time.`];
  if (m.hint) lines.push(m.hint);
  return lines;
}
