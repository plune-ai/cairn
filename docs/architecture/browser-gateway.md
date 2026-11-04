# BrowserGateway — the hybrid browser layer

One interface over two backends (ADR-0003). The agent always talks to the abstraction —
*what exactly* navigates the page is an implementation detail driven by config.

## Why a hybrid

- **PRIMARY = `playwright` (the library, in-process):** holds `storageState` (cookies+**localStorage**),
  captures `page.ariaSnapshot()` and `page.screenshot()`, **and runs** the generated `@playwright/test` tests.
  The driver = the output format → there's no "seam" between exploration and generation, and the tests are validated immediately.
- **SECONDARY = a wrapper over `@playwright/cli` (Microsoft):** a token-efficient agent interaction loop
  (snapshot/navigate/click) that returns ref-annotated snapshots. Does not run tests.

> `playwright-mcp` remains a drop-in alternative to SECONDARY (the same ref+code idea) — see ADR-0003.

## Interface (sketch)

```ts
export interface BrowserGateway {
  observe(opts: ObserveOptions): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  session(): SessionApi;                       // load/save storageState
  runTests(globs: string[]): Promise<TestRunReport>;  // ⚠️ PRIMARY only
  close(): Promise<void>;
}

export interface BrowserBackend {              // implemented by both backends
  observe(opts: ObserveOptions): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  session(): SessionApi;
  runTests?(globs: string[]): Promise<TestRunReport>;  // optional — lib only
}

export function makeGateway(cfg: AppConfig): BrowserGateway; // the factory selects the backend
```

`Observation`, `ElementRef`, `ActResult`, `SessionApi` — in [`data-contracts.md`](./data-contracts.md).

## What a click did (#224)

`ActResult.ok` says the action happened: for a click, that it was made. On the lib backend a click also returns
`outcome`, one name from a closed set, and `effect`, the record behind it (`src/browser/types.ts`):

- **Effects**, most telling first: `navigated` (the URL changed), `overlay-opened` / `overlay-closed` (a `dialog`,
  `alertdialog`, `menu` or `listbox` appeared or went away), `state-changed` (the element's own `checked`,
  `expanded`, `pressed` or `selected`), `content-changed` (other lines of the page's ARIA snapshot), `network-only`
  (nothing visible, but a request answered 2xx: a silent save), `no-effect` (a dead click, still `ok: true`).
- **Failure causes**, read from Playwright's call log (`ok: false`): `intercepted` (another element takes the
  pointer, usually an overlay), `not-visible`, `not-enabled`, `detached` (the element observed a moment ago is no
  longer on the page), `timeout` (found, but no reason given before the limit).

After the click the backend watches 250 ms for the requests it starts and the DOM it changes, waits up to 2 s for
those requests to answer, and reads the page again. Only document, fetch and XHR requests on the page's own origin
are recorded: method, path and status, never a body or a header, and query values that look like secrets are
redacted with `src/decider/redact.ts`. The cli backend records none of this (`outcome` is absent).

A run keeps every click's effect (`ExploreOutcome.clicks`): the clicks with no effect are listed in `report.md`
(*Dead clicks*) and `report.json` (`deadClicks`), and the requests go to `requests.json`.

## Routing contract (IMPORTANT)

```
observe()/act()  → the backend per config.browser.backend ('lib' | 'cli')
runTests()       → ALWAYS playwright-lib (cli can't run tests)
session()        → owner of storageState — playwright-lib
```

That is, even in `backend: 'cli'` mode the gateway keeps a lib instance for `runTests`/`session`.
This is fixed by ADR-0003; the implementation is in `browser/gateway.ts`.

## Observation parity

`PageObserver.capture()` normalizes the output of **both** backends into the same `PageStudy` shape
(screenshotB64 + ariaYaml + `ElementRef[]`). The contract test (Sprint 6 / plan §8) runs one
shared suite against both backends — a guarantee of interchangeability.

## CLI backend boundaries

What `@playwright/cli` can / can't do vs the lib is determined by **Spike S3** (Sprint 1),
report: [`../research/spike-S3-playwright-cli-boundary.md`](../research/spike-S3-playwright-cli-boundary.md).
In particular: the snapshot format, the ref scheme, and whether the emitted Playwright code for an action is captured.

## Session (cookies + localStorage)

`SessionStore` (the `session/` module) persists `storageState` as JSON. Playwright `storageState`
includes cookies + localStorage + IndexedDB (NOT sessionStorage). MVP: the operator passes a **ready**
`storageState`; interactive login-and-save is Sprint 6. Procedure: [`../runbooks/save-session.md`](../runbooks/save-session.md).
**Security:** `.auth/` and `*.storageState.json` are in `.gitignore`, never to be committed.
