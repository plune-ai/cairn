import type {
  ActResult,
  Action,
  ElementRef,
  ElementState,
  Observation,
  ObserveOptions,
  SessionApi,
  TestRunReport,
  VerifiedElement,
  WriteGuard,
} from "./types.js";

/**
 * A single browser backend. Both (playwright-lib, playwright-cli) implement observe/act/close;
 * `runTests`/`session` — lib only (the CLI does not run tests and does not own storageState, ADR-0003).
 */
export interface BrowserBackend {
  observe(opts: ObserveOptions): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  /** Verify locators on the current page (count per element). */
  verify?(elements: ElementRef[]): Promise<VerifiedElement[]>;
  /** Current element state (visible/enabled/checked) — for act→observe. */
  getState?(element: ElementRef): Promise<ElementState>;
  /** #225 review 3: abort every request but GET, HEAD and OPTIONS until released (lib only; the cli cannot). */
  guardWrites?(): Promise<WriteGuard>;
  session?(): SessionApi;
  runTests?(globs: string[]): Promise<TestRunReport>;
  close(): Promise<void>;
}

/**
 * Hybrid abstraction (ADR-0003). The agent always talks to it.
 * Routing: observe/act → backend per config; runTests/session → ALWAYS lib.
 */
export interface BrowserGateway {
  observe(opts: ObserveOptions): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  /** Verify-before-design: check locators (count===1) on the observed page. */
  verify(elements: ElementRef[]): Promise<VerifiedElement[]>;
  /** Element state (visible/enabled/checked) — for act→observe grounding. */
  getState(element: ElementRef): Promise<ElementState>;
  /**
   * #225 review 3: the network guard of the observe/act backend — on until released. Absent, or undefined, when that
   * backend cannot guard the network (the cli backend): a caller that needs the guard then presses nothing. Rejects when
   * it could not start, with a `code` in fixed words; its message is not for a report.
   */
  guardWrites?(): Promise<WriteGuard | undefined>;
  session(): SessionApi;
  runTests(globs: string[]): Promise<TestRunReport>;
  close(): Promise<void>;
}

export type { BrowserBackend as Backend };
