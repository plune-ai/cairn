/**
 * Tiered transient-error recovery for browser navigation (BORROW-02, #90).
 *
 * A page navigation can fail for two very different reasons:
 *  - **transient** — the SPA aborted the in-flight `goto` with a redirect, the network blipped, or a
 *    load-state wait timed out. Waiting a beat and retrying the SAME page usually fixes it, and crucially
 *    keeps the grounded state (the backend's ref→locator map) intact — no expensive reload needed.
 *  - **fatal** — DNS failure, connection refused, bad cert, a missing browser binary, or anything we don't
 *    recognise. Retrying the same page won't help; only here do we escalate to the expensive recovery
 *    (recreate the page), which loses grounding and forces a re-observe.
 *
 * The borrowed insight (testomatio/explorbot PR #59): handle transient navigation errors BEFORE
 * escalating to browser recovery, so flaky navigation doesn't waste a run or drop grounded state.
 */

export type ErrorClass = "transient" | "fatal";

/** Navigation errors worth a cheap wait + retry on the SAME page (everything else is fatal). */
const TRANSIENT_NAV: RegExp[] = [
  /net::ERR_ABORTED/i, // SPA redirect interrupts the in-flight goto — the classic flake
  /net::ERR_NETWORK_CHANGED/i,
  /net::ERR_CONNECTION_RESET/i,
  /net::ERR_CONNECTION_CLOSED/i,
  /net::ERR_TIMED_OUT/i,
  /net::ERR_HTTP2_PROTOCOL_ERROR/i,
  /Timeout .* exceeded/i, // goto / waitForLoadState timeout
  /Execution context was destroyed/i, // navigation mid-evaluate (SPA)
  /frame was detached/i,
  /navigation interrupted/i,
];

/**
 * Classify a thrown browser error. Unknown errors default to `fatal` — we never want to mask a real
 * bug behind silent retries; only errors we positively recognise as transient earn a retry.
 */
export function classifyBrowserError(e: unknown): ErrorClass {
  const msg = e instanceof Error ? e.message : String(e);
  return TRANSIENT_NAV.some((re) => re.test(msg)) ? "transient" : "fatal";
}

/** The three navigation primitives the recovery ladder drives (injected so it's unit-testable). */
export interface NavOps {
  /** Perform the navigation (e.g. page.goto). Throws on failure. */
  goto(): Promise<void>;
  /** Cheap settle: wait for the SPA to quiesce before a transient retry (same page). */
  settle(): Promise<void>;
  /** EXPENSIVE recovery: recreate the page — grounded state is lost. Only fatal/exhausted reaches here. */
  recreate(): Promise<void>;
}

export interface NavRecoveryOpts {
  /** Transient retries on the same page before escalating to recreate (default 2). */
  retries?: number;
}

/**
 * Tiered navigation recovery ladder:
 *  1. try `goto`;
 *  2. on a **transient** error with retries left → `settle` + retry the SAME page (grounding kept);
 *  3. on a **fatal** error, or once transient retries are exhausted → `recreate` (expensive) + one final
 *     `goto`. If even that throws, the error propagates.
 */
export async function navigateWithRecovery(ops: NavOps, opts: NavRecoveryOpts = {}): Promise<void> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await ops.goto();
      return;
    } catch (e) {
      const canRetry = classifyBrowserError(e) === "transient" && attempt < retries;
      if (!canRetry) {
        // fatal, or transient retries exhausted → escalate to expensive recovery
        await ops.recreate();
        await ops.goto(); // final attempt on the fresh page; throws → propagate
        return;
      }
      await ops.settle(); // cheap: let the SPA settle, then retry the same page
    }
  }
}
