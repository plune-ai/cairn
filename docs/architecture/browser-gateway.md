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
something (an allow-list); every other one is recorded as skipped with the reason. A wizard is a dialog with a Next
and a Back or a step indicator, never an `alertdialog`. The result goes to `overlays.json`, `report.json`
(`overlays`) and `report.md` (*Overlays*).

#### The invariant: exploring overlays changes nothing on the server

Exploring overlays changes nothing on the server, whatever the button is called: not while it runs, and not after it
ends. No write sent because of a press may ever arrive. This rests on the network, not on names:

- **What may be pressed is read first, on the crawler's own page.** Reading presses nothing, and it is the page the study
  describes. With nothing to press, no second browser is started (`guard: "none"`, `note`).
- **Presses happen in a throwaway browser** (`guardWrites()`, lib backend). A browser process of its own, with a
  context made from the crawler's `storageState()`, with the same context options, and with the sessionStorage of the
  crawler's tab carried in for the origin it is on. Until the guard is released, every `observe`, `act`, `verify` and
  `getState` goes there. The crawler's own context and page never see a press and come back as they were, refs included.
- **IndexedDB goes in only as far as Playwright restores it.** A falsy value (`""`, `null`, `false`, `0`) comes back as
  `undefined`, and a CryptoKey, a Blob or a Map does not come back at all; the cause is in Playwright. So the buttons of a
  session kept that way may not appear in the throwaway browser. Such a button is not pressed, and is reported as not
  there. A record under the key `0` stops the guard from starting at all (below).
- **The write guard is on the browser, not on a page.** A Fetch interception on that browser, on before its first
  context exists and never taken off, aborts each request whose method is not GET, HEAD or OPTIONS: a form post, a fetch
  or XHR write, a beacon, a keepalive request, a form sent from script, from a page, its frames, the tabs it opens or
  any worker. Each one stopped is recorded (method, path written like a recorded request, the element pressed last
  before it, how often) and reported: `overlays.json` (`guard`, `blocked`) and a table in `report.md`. It goes by the
  method alone, so a stopped request is not necessarily a write: an app may also read through POST (GraphQL), and a
  trigger that shows only once that answer is in is then reported as not there. Background Fetch, which sends where this
  interception does not look, is switched off in that browser.
- **There is no release moment.** The release — in `finally`, so also on an error — kills that process with the guard
  on. What a page was sending, and what it left for later (an outbox in localStorage), ends with it. Nothing flows
  back: no cookie, no storage. So nothing it did can reach the server later. A route on a context would not hold this:
  its interception belongs to each page, frame and worker, and what it holds is let go when they go. Probes saw POSTs
  arrive with the route on from a popup closing itself, from a cross-origin frame removed, and from a context closing;
  a SharedWorker and `fetchLater` passed it altogether.
- **One exception to "nothing but GET, HEAD and OPTIONS".** On a configured `--channel` (full Chromium) over HTTPS, a
  page with `Reporting-Endpoints` and a CSP `report-to` gets the browser's own Reporting API report: a POST
  (`application/reports+json`) that passes this interception, reaches the server and is not listed in `blocked`. It is
  not the app's doing. It is not switched off, because `--disable-features` would replace the list Playwright passes
  there itself, and that list is no public API. Network Error Logging was not checked.
- **What it does not see.** A WebSocket message, and a GET that changes the server against HTTP's rule. A cookie set
  while pressing stays there too: on a site that rotates its session on every GET, the crawler is signed out afterwards.
  The result says so (#252): when the site replaced or removed an `httpOnly` cookie the crawler holds, `note` counts
  them and says the rest of the run may be signed out. A session cookie readable by script is not looked at, so an
  analytics cookie that changes on every page view raises no note.
- **What a stopped request leaves behind.** A press whose request the guard stopped is not a dead click: its outcome
  is `unknown` (a dialog that opens only once the server answers never opens there), and the request is in `blocked`
  only, not in the run's `requests.json`. Reading the crawler's session with IndexedDB leaves Playwright's database
  connections open in the crawler's document, so an upgrade the app makes there waits; the run loads the page again
  right after exploring overlays, which ends them.
- **No guard, no press.** A backend that cannot guard the network (the cli backend: the gateway has no `guardWrites()`)
  presses no trigger and no wizard step while exploring overlays. It reads the overlays already open and says so
  (`guard: "none"`, `note`). A guard that did not start does the same, and says that instead: `the write guard did not
  start (<category>)`, in `note` and `skipped`. The category is one of `SESSION_READ_FAILED` (the crawler's session could
  not be read within 10 s, as on a page with a blocked IndexedDB upgrade), `BROWSER_START_FAILED` and
  `SESSION_RESTORE_FAILED` (a record under the key `0`, a database of 200 MB), or else an error's name. Never its message:
  that can quote what the session holds.
- **An empty result says why.** A button that could not be read, a trigger that was not there where the presses happen,
  and a press that failed (the browser died, say) each get their own reason in `skipped`, and are counted in `note`. A
  button only counts as announcing nothing when it was read and has none of the three attributes.
- **Checks that do not depend on a name**, for every press — triggers, nested probes, a wizard's Next and Back alike:
  an element whose `getState()` says `submitsForm` is not pressed (a `type=submit` button or a `<button>` with no type
  inside a form, or joined to one by the `form` attribute), nor a disabled one; a trigger must announce a popup.
- **Names**, kept only in forms the guard cannot see: a deletion or a sign-out (`DESTRUCTIVE` in
  `src/flow/crawl.ts`, `isDeletionIntent` in `src/safety/guardrails.ts`), which is often a plain GET link; and a
  completion (Save, Submit, OK…), which is never a trigger. There is no list of payment or order names: every such
  button writes, and the guard stops every write; a list both missed names («Complete payment», «Book now») and
  refused safe ones («Sort order», «Purchase history»).

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
