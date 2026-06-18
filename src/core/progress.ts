/**
 * CLI progress renderer. Long LLM-bound steps (designTestCases ~a minute) emit no progress
 * events while they run, so the CLI looked frozen. In a TTY we animate the CURRENT step in place
 * (`▸ <label> ⠋ 12s`) on a single stderr line; when the next event arrives the previous step is
 * frozen as a permanent line. In a pipe/CI (no TTY) we fall back to one plain line per event.
 *
 * Lives in core/ (shared CLI presentation, like reporting.ts) so both the inline CLI actions
 * (design/automate) and the explore modality can use it without a cli→core layering inversion.
 * Pure of process globals (write/isTTY/now are injected) so it is unit-testable with fake timers.
 * CR/LF/ESC are built from char codes to keep invisible control bytes out of the source.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const CLEAR_LINE = CR + ESC + "[K"; // carriage-return + ANSI erase-to-end-of-line

export interface CliProgress {
  /** Report a new step. Freezes the previous step's line, then animates this one (TTY). */
  event: (text: string) => void;
  /** Commit the current step and stop animating. Always call once when the run settles. */
  stop: () => void;
}

export function makeCliProgress(opts: {
  write: (s: string) => void;
  isTTY: boolean;
  now: () => number;
  intervalMs?: number;
}): CliProgress {
  const { write, isTTY, now } = opts;
  const intervalMs = opts.intervalMs ?? 120;

  // Non-TTY: a spinner would just spew control codes into a pipe/file — print plain lines instead.
  if (!isTTY) {
    return {
      event: (text) => write(`  ▸ ${text}${LF}`),
      stop: () => undefined,
    };
  }

  let current: string | null = null;
  let startedAt = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const render = (): void => {
    if (current === null) return;
    const elapsed = Math.floor((now() - startedAt) / 1000);
    write(`${CLEAR_LINE}  ▸ ${current} ${FRAMES[frame % FRAMES.length]} ${elapsed}s`);
    frame += 1;
  };

  const commit = (): void => {
    if (current === null) return;
    write(`${CLEAR_LINE}  ▸ ${current}${LF}`); // freeze the step as a permanent line (no spinner)
  };

  return {
    event: (text) => {
      commit(); // the previous step is done
      current = text;
      startedAt = now();
      frame = 0;
      render(); // show the label immediately, don't wait for the first tick
      if (!timer) timer = setInterval(render, intervalMs);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      commit();
      current = null;
    },
  };
}
