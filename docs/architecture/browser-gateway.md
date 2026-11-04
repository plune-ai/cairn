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

### Overlays are states (#225)

An element inside a `dialog` or `alertdialog` carries its `scope`, and every lib-backend call finds it through the
dialog: `getByRole('dialog', { name }).getByRole(role, { name })`, so the Save of a dialog and the Save of the page
under it are two elements. `observe()` also returns `nonModal`: the dialogs the DOM says do not block the page
(no `aria-modal`, not a native `showModal()` dialog; an `alertdialog` is always modal), such as a cookie banner.
While a modal overlay is open, `act()` does not touch an element that lies under its top one: it answers
`ok: false, outcome: "under-overlay"` at once, where the click would have waited out a 30 s timeout. `act()` also
takes `{ kind: "press", key }` and `{ kind: "click-outside", scope }` (lib backend only; the cli backend answers
`ok: false`). A click outside is made only at a point checked first with `elementFromPoint`: the element there is
outside the overlay `scope` and is nothing a click acts on (no link, button, field, label, click role, tabindex,
inline handler or pointer cursor); corners first, then the edges, then a grid. When no point passes, nothing is
clicked and the answer is `ok: false`. `getState()` also returns `popup`: the element's `aria-haspopup`,
`aria-expanded` and `aria-controls`, which the ARIA snapshot does not show, and `submitsForm` when pressing the element
submits a form (a `type=submit` button, or a `<button>` with no type, inside a form); such a button is never pressed
while looking for an overlay.

Detection and the explorer sit above the gateway: `src/observe/overlays.ts` reads a snapshot (pure, no LLM: `dialog` and
`alertdialog` are overlays; a `menu`, `listbox` or `complementary` is one when it was not on the baseline page;
`status` / `alert` texts are recorded as toasts, never as states), `src/agent/overlays.ts` presses what could open one,
records the trigger, the elements, the exits (Escape and a click outside probed, the buttons read), the nested
overlays and the steps of a wizard. To look for an overlay it presses only a button whose `popup` says it opens
something (an allow-list); every other one is recorded as skipped with the reason. On top of that it presses nothing
that the destructive-action filters refuse (`DESTRUCTIVE` in `src/flow/crawl.ts`, `isDeletionIntent` in
`src/safety/guardrails.ts`), nothing that completes a form (Save, Submit, OK…) and nothing disabled. A wizard is a
dialog with a Next and a Back or a step indicator, never an `alertdialog`; its Next and Back go through the same
filters. The result goes to `overlays.json`, `report.json` (`overlays`) and `report.md` (*Overlays*).

### Visible and unique in its scope (#226)

`act()`, `verify()` and `getState()` never take «the first of several». They look among the visible elements of the
element's scope (its dialog, or the page). One match is the element. Several are narrowed by the accessible name of the
container the element sits in (`ElementRef.context`: named `row`, `listitem`, `article`, `group`, `region`, `form`,
`treeitem`, nearest first): the first container after which exactly one match is left wins (`narrowedBy` in
`verify()`), and the locator is `getByRole('row', { name }).getByRole(role, { name })`. Links that share one `href` are
one destination. Otherwise the element is `ambiguous`: no click (`outcome: "ambiguous"`, `ambiguous: { role, name,
count }`), no state read, and the run lists it (`report.json` → `ambiguous`, *Ambiguous elements* in `report.md`). The
generated code is held to the same rule before it is run: `lintErrors` (`src/codegen/lint.ts`) rejects
`page.mouse.click`, `force: true` and an uncommented `.first()` / `.nth(`, and `runRepairLoop({ errors })` turns each
into a failed result for the repair loop.

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
