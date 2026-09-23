import { DeciderUnavailable } from "./types.js";

export interface GuardOptions {
  timeoutMs: number;
  /** Per-run ceiling on decide() calls (DECIDER_MAX_CALLS). A retry is part of its call, not a new one. */
  maxCalls: number;
  /** Pause before the single retry on 429/5xx. */
  retryDelayMs?: number;
}

const retryable = (e: unknown): boolean =>
  e instanceof DeciderUnavailable && e.status !== undefined && (e.status === 429 || e.status >= 500);

/**
 * The layer's bounds (ADR-0022, spec §3.6): a per-run call ceiling, ONE timeout over the whole call
 * (retry included), exactly one retry on 429/5xx. Everything that goes wrong surfaces as
 * DeciderUnavailable, so a call site has one thing to catch.
 * ponytail: fixed retry delay; honour `retry-after` if Jev's 429s turn out to need it.
 */
export function guarded(opts: GuardOptions) {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    async run<T>(attempt: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (calls >= opts.maxCalls) throw new DeciderUnavailable(`call ceiling reached (${opts.maxCalls} per run)`);
      calls += 1;
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new DeciderUnavailable(`timeout after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      });
      const work = (async (): Promise<T> => {
        try {
          return await attempt(ctl.signal);
        } catch (e) {
          if (!retryable(e) || ctl.signal.aborted) throw e;
          await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 250));
          return attempt(ctl.signal);
        }
      })();
      try {
        // A request that rejects after the timeout won is still handled: race subscribed to it.
        return await Promise.race([work, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
