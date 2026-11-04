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

- **Effects**, most telling first: `navigated` (the URL changed, `pushState` included), `opened-tab` (a new tab or
  window; it is closed again), `downloaded` (a file; the download is cancelled), `overlay-opened` / `overlay-closed`
  (a `dialog`, `alertdialog`, `menu` or `listbox` appeared or went away), `state-changed` (the element's own
  `checked`, `expanded`, `pressed` or `selected`, the focus moved to another element, or the page scrolled),
  `content-changed` (other lines of the page's ARIA snapshot, or a text that appeared, even one gone again by the
  time the page is read), `network-only` (nothing visible, but a request answered 2xx: a silent save), `unknown` (the
  page could not be read before or after the click, or its next page is still on its way), `no-effect` (no change
  seen, still `ok: true`).
- **Failure causes**, read from Playwright's call log (`ok: false`): `intercepted` (another element takes the
  pointer, usually an overlay), `not-visible` (also an element still in the DOM but hidden), `not-enabled`,
  `detached` (found, then gone during the click), `not-found` (nothing matches the element observed a moment ago:
  removed or renamed), `timeout` (found, but no reason given before the limit).

Before the click a small page-side watch notes the element's state, the focus and the scroll, and a
`MutationObserver` notes whether the DOM changed and which texts appeared. After the click the backend waits 250 ms,
and while document, fetch, XHR or script requests of any origin are in flight it waits for them, up to 2 s after
the click, then gives their answers 250 ms to render. It reads the ARIA snapshot again only when the DOM changed, so
a quiet click costs no snapshot. A click that still looks dead is read again every 100 ms until 1.2 s after the
click (2 s for a link with a `target`, whose tab can be slow to open). A page whose next document is still on its
way is not read: it is `unknown`, not waited for. Clicks made only to set things up are not watched
(`{ kind: "click", watch: false }`: the probe's reverting click, the sign-in click).

Only document, fetch and XHR requests on the page's own origin are recorded: method, path and status, never a body,
a header or a query value. The path keeps its query keys (`/api/save?token=‹v›&page=‹v›`), credential-shaped path
segments (a JWT, long hex, a UUID, a long number, a long run mixing letters and digits or cases) become `‹v›`, and
`;` parameters are dropped. A request the page sends on a timer (one endpoint seen twice within 10 s outside any
click) is a poll: neither waited for nor recorded. The cli backend records none of this (`outcome` is absent).

A run keeps every click's effect (`ExploreOutcome.clicks`), and the requests go to `requests.json`. The clicks with
`no-effect` go to `report.json` (`deadClicks`) and `report.md` (*Dead clicks*), page URLs written the same way and
without a fragment; a link the crawl followed to another page is left out. The report says that Cairn saw no change
within 1.2 s of the click and that it is to be checked by hand, and lists what Cairn cannot see: a server-side
effect whose request got no answer within 2 s or went to another origin, a later change, a change inside an iframe
or drawn on a canvas, a change of style alone. On the cli backend `deadClicks` is absent and the section says the
clicks are not recorded there.

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
