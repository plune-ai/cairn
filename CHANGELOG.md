# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Screencasts name the case they belong to.** Each entry of `screencasts.json` (and `ScreencastEntry`) of a generated
  test carries `stableId`, the case's id across runs, so a consumer matches a screencast and its trace to the case by id
  instead of by the Playwright test title, which the model picks. The model now returns, per spec file, which listed
  case each `test()` covers (`CodegenReplySchema`); cairn writes that case's `stableId` onto the test as a Playwright
  annotation (`{ type: "stableId" }`) and reads it back from the run. A hand-written spec, an unmapped test or a case
  without a `stableId` gets none; `test` is unchanged.

## [0.11.0] - 2026-11-13

### Added

- **Docs for `cairn mcp-test`.** A guide ([`docs/mcp-test.md`](docs/mcp-test.md)) that goes from reading a server to running cases on a test
  account and reading the report, with real outputs, the permission levels, the limits of what a pass proves and a
  troubleshooting table; a [runbook](docs/runbooks/test-an-mcp-server.md); `docs/mcp.md` now covers `cairn mcp` only and points to
  the guide. The help text of `cairn mcp-test` no longer says that adversarial cases are never sent.
- **`cairn mcp-test` sends the cases (MCP-E5).** With `--allow-tools`, `--allow-read-only-hints` or `--allow-mutations` the
  generated and adversarial cases are sent through the call guard, one call per case, with five states (`passed`, `failed`,
  `not-sent`, `could-not-run`, `needs-review`), per-tool coverage (`--min-coverage`, `--count-partial`), `--max-response-bytes`
  and the artifacts `report.json` (`mode: "mcp"`), `report.md`, `mcp-evidence.json` and `testcases/`. Exit codes: 0 at least one
  case passed and no case failed, could not run or needs review (a guard refusal does not count), 1 failed or stopped, 3 coverage,
  4 budget, 5 not proven. A stdio server that exits is restarted once; later results are marked `afterRestart`.
  Review round: a timeout or a closed connection is decided only by facts on this side (the call's own timer, the transport
  closing), never by an error code or text the server sent; one answer is bounded while it is read (HTTP body counter, stdio
  message cap that stops the child); the tool is read again before every call and a failed read means no call; a Negative case
  passes only on an error its `expect` lists, any other code is `needs-review`; an output schema is compiled once per tool;
  `--max-response-bytes` is a whole number from 1 to 67108864.
  Second review: an interrupt during a call is `could-not-run` and stops the run (an error is a server answer only when no local
  cause is set); a failed re-read is `could-not-run`, and a dead connection found by it is the one restart; every HTTP response
  has a byte limit (8 MiB for handshake and list pages); a missing stdio size counter is reported (`stdioSizeCounter`); one
  restart budget for every cause of a lost child; budgets are checked before the re-read; `initialize` errors are described by
  what the server answered; JSON-RPC codes are kept in the evidence and -32603 on hostile input is counted as advice.
- **`cairn mcp-test --adversarial` (MCP-E3).** Adds `psycho` and `hacker` cases for tool arguments (extreme numbers, long,
  empty, zero-byte and unpaired-surrogate strings, a deep array, a forbidden extra property, a `__proto__` key, and four
  harmless injection strings with their WSTG ids) and tags the `normal` and `curious` ones. Cases are written to
  `mcp-cases.json` with the schema verdict, a robustness expectation and the call guard's current verdict; nothing is
  sent. Limits on string length and depth are written in the file. `findAdvice` (stack, path, SQL signs in an error
  text) only advises and carries no server text. A schema-check timeout on an adversarial value skips only that tool's
  adversarial cases (counted under skipped); one candidate that cannot be checked is recorded alone. See `docs/mcp.md`.

- **`cairn mcp-test`: test cases from `inputSchema` (MCP-E2).** Besides `mcp-model.json` and `mcp-guard.json`, the command
  writes `mcp-cases.json`: for every tool, a valid case, one case per missing required argument and per wrong type,
  boundary cases on and beyond each limit, one case per `oneOf`/`anyOf` branch and per `enum` value, and one with every
  argument. No model, no network, no tool call. Each case is checked against the tool's schema (Ajv, 2020-12): a case that
  does not pass or fail as expected is not written but listed as skipped with the keyword. `$ref` is followed when local;
  external, cyclic, too deep or too large schemas are skipped. `--max-cases-per-tool` (default 12) cuts the rest and the
  summary counts them; `--examples <file>` gives the arguments of the valid case. Every schema check
  runs in a worker thread, with a 2 second limit per tool, a 15 second budget for the run, and a 256 KiB limit on a
  tool's schema; the cases are made after the server connection is closed. Tools with the same name are all skipped.
  See `docs/mcp.md`.

- **`cairn mcp-test` call guard (MCP-E4).** Nothing is called by default. `--allow-tools` takes exact names (no "all", no
  patterns), `--allow-read-only-hints` trusts the server's `readOnlyHint` claim only for a plain ASCII name whose first word is a read verb (`get`, `list`, `search`, ...), and the report says so,
  `--allow-mutations` needs the name in `--allow-tools` as well and prints a test-account banner. A tool whose name or
  title reads as a deletion (`delete_file`, `deleteFile`, `видалити_файл`, ...) is never allowed on a hint; a tool changed
  after you saw it, a name with control characters and look-alike names are refused. `--max-calls`, `--rps`,
  `--call-timeout` and `--time-budget` bound the calls (exit `4` when a budget runs out). The command still only reads the
  server: asking for calls exits `5` (nothing sent, nothing tested). See `docs/mcp.md`.

- **`cairn mcp-test`: read a foreign MCP server (MCP-E1).** `cairn mcp-test -- <command> [args]` (stdio, with `--env` and
  `--cwd`) or `cairn mcp-test --url <address> [--header "Name: Value"]` (Streamable HTTP) connects, runs `initialize`, reads
  the tools, resources, resource templates and prompts page by page (bounded by `--max-pages` / `--max-entries`) and writes
  `mcp-model.json` plus a short summary. The file is byte-identical for the same server; a list cut by a limit makes the
  model `complete: false` with the reason. Header and environment values are never stored. In what is
  printed and saved, string values are masked: a value with a sensitive name from 4 characters, any other from 8
  (common values such as `true` are not); shorter neutral values, other encodings and secrets in the address path are
  not, and a long ordinary word passed as a value is replaced wherever the server repeats it. The server process gets
  no provider keys and is stopped when the run ends; redirects are not followed, and a 401 that points to
  authentication metadata on another origin stops the run without visiting it. Exit `1` when the server cannot be read,
  `5` when it has no tools. No tool is called and no case is generated yet. See `docs/mcp.md`.

- **The agent takes the mailbox and TOTP steps itself, `cairn doctor` checks Mailsac (#257, ADR-0023 §4).** With a
  `MailboxSession` passed (`ExploreInput.mailbox`, `runAutomate`'s `mailbox`), a fixed rule, not a model's verdict,
  decides when the steps are needed: a field asking for a one-time code (promo, postal and similar codes are not one),
  page text saying an e-mail was sent ("check your email", "перевірте пошту"), or a case step naming the letter or a
  code from it. A link from the e-mail is opened, a code from it or a TOTP code (secret read from the variable named by
  `totpSecretEnv`, default `TOTP_SECRET`) is filled. The generated `@playwright/test` specs then import a written
  `mailbox.fixture.ts` whose `mail` fixture reads `MAILSAC_API_KEY` and the TOTP secret from the environment by name when
  a test runs; a generated file that holds a secret value is never written. Without a session nothing changes but one
  progress line that names the page as needing e-mail/OTP. `cairn doctor` adds a test-mailbox section: whether
  `MAILSAC_API_KEY` is set (never its value), the domain (the public `mailsac.com` is flagged) and the reply of one read
  on it. `mailboxNeed` is exported. See `docs/mailbox.md`.

- **`cairn check-docs`: do the docs still match the UI? (#231)** `cairn check-docs --docs <dir|file> --url <app>
  [--session <s>] [--spec <file>]` walks the app as `collect-docs` does and compares it with docs in that format. The
  walk is written in the docs format and read back with the same reader as the docs. Screens are paired by address,
  overlays by kind and title (a section alone on both sides with the same address or the same opener is the same one,
  renamed); within a section, fields and controls by role and name, and where a link or a trigger leads, compared
  through the pairing so a renamed screen is one difference. Three kinds of mismatch: in the docs, not in the UI; in the
  UI, not in the docs; name differs. With `--spec` (OpenAPI 3.x, JSON or YAML), an API operation the app called while
  walked that the spec lacks is a mismatch too; one the spec has that the walk did not see is listed, not counted. The
  report, `check-docs.md` in `runs/check-docs-<id>/` (or `--out`), links each mismatch to its docs section and to the
  screen as the walk saw it. Exit 0 when the docs match, 2 on a mismatch, 1 when the docs cannot be read or the app
  cannot be walked. It makes no LLM call and needs no API key. See `docs/check-docs.md`.

- **`cairn collect-docs`: an app's user docs, written by walking its UI (#24).** `cairn collect-docs --url <app>
  [--session <s>]` (alias `cairn docs`, which was a coming-soon stub) follows the app's links, same origin and never a
  sign-out or deletion link, up to `--max-pages` screens (default 10), and opens the dialogs, drawers, menus and wizards
  of each screen as `explore` does (#225), under its write guard, so documenting changes nothing on the server. It
  writes `docs.md` in `runs/docs-<id>/` (or `--out`): one `## <Kind>: <title>` section per screen and overlay with its
  screenshot, what it is, who gets here or what opens it, its ways out, its fields and which are required (`required` or
  `aria-required` in the DOM), the steps of a wizard and what blocks Next, what a user can do and where each link or
  button leads, and what a user might come there for; then a `## Questions` list. What the walk could not explain — a
  status or a label shown without explanation, an abbreviation — is a question there, never a guess in the text. The
  app's API requests seen on the way become `openapi.derived.json` (#229). The format is described in
  `docs/collect-docs.md`.

  One LLM call per screen describes the screen and its overlays from the ARIA snapshot. Its answer is cached in
  `.cairn-cache/understanding/screens/` by the URL and a fingerprint of what the walk saw there (ADR-0018), so a second
  walk of an unchanged screen makes no call; `--fresh` describes every screen again. An address that cannot be reached
  or a start page with no heading and no control stops the run with a one-line error and writes nothing.
- The lib backend's element state now says whether a field is required (`ElementState.required`), and
  `exploreOverlays` takes an `onOverlay` hook, called while each overlay it finds is still open.

## [0.10.0] - 2026-11-11

### Added

- **An OpenAPI draft from the traffic recorded while exploring the UI (#229).** On the lib backend `explore` and
  `design` record the application's API requests — those made while pages load and those clicks start — and at the
  end of the run fold them into OpenAPI 3.0, saved as `openapi.derived.json` in the run directory, ready for
  `cairn api --spec`. Ids in a path become parameters (`/projects/123` and `/projects/456` → `/projects/{id}`),
  with methods, response codes, query names and body schemas inferred from the examples, all marked
  `x-cairn-derived: true`. Pages, scripts, styles, images and fonts are left out, and so is every origin but `--url`'s
  unless `--api-origin <list>` (comma-separated origins, no `*`, no user or password) allows it; the run log counts what
  was left out and names up to three of the origins refused. An answer a service worker made itself is left out too, and
  the log does not count it. The host and the port are not in the file: its title is generic and it has no `servers`,
  since `cairn api` takes the address from `--base-url`.

  A string from the traffic reaches the file only after passing a fixed form, which leaves out most free text and
  random-looking text but not all of it. A name (a JSON key, a form field, a query name) must match
  `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` and not read as random (long hex, letters that flip case, digits in three places). A
  word of a path must be ASCII letters with digits only at the end of a `-`/`_` part, up to 32 characters, not 6 or more
  hex characters and not shaped like a credential. Both may have at most 4 `-`/`_` parts, at most 3 digits at the end of
  a part and at most one part of 4 or more characters that are all hex; from 8 letters on, at least one letter in five
  must be a vowel (`y` counts) and the case may turn from lower to upper at most 3 times. A name that fails is left out
  alone, so `user.name` and `filter.status` are left out too; a word that fails is a parameter. An object most of whose
  keys fail, with many keys of one shape, or with 8 or more keys whose values all have one non-scalar shape is a map
  (`additionalProperties`). A media type is written from a fixed set. Bodies, headers, cookies and query values are not
  written as such.

  A secret reaches the file neither as a word of a path, nor as a run of whole parts of a word, nor as a name. These
  count as secrets: the value of a header, query, form or body field, HAR entry or Postman variable whose name has
  `authorization`, `cookie`, `api key`, `token`, `secret` or `password` in it; every cookie; the user and password of a
  URL in a HAR or a collection; a value of a HAR or a collection that is shaped like a credential (a JWT, long hex) or
  that the run's secret reader takes from a `name: value` pair; and the run's own secrets (knowledge, environment). A value
  under 4 characters, one equal to its field's name and a word of the document's vocabulary (`string`, `true`, `password`)
  are not. The comparison ignores case, letter width, spaces, `-`, `_`, `+`, zero-width characters and soft or non-breaking
  hyphens, takes a cookie without its quotes or its signature, and splits camelCase: `resetOpenSesame` holds `open-sesame`,
  and a secret `admin` leaves `administrators` alone.

  A word of a path with several parts (`jane-roe`, also as `jane_roe` or `janeRoe`) that equals a value the run read,
  compared the same way, is a parameter; an address counts by its local part too. The run reads values of up to 256
  characters from JSON bodies up to 1 MB, query strings, url-encoded forms, text bodies and headers. It does not see
  values in JSON keys, in CSV or other answers that are not JSON, in answers over 1 MB or in multipart bodies. A word of
  one part (`projects`, `v1`) is compared with secrets only, since no value tells it from a route. Three or more
  distinct words in the same place of a path, with the same places before them and the same ending that holds a literal
  word, are parameters: `/api/alice/profile`, `/api/bob/profile` and `/api/carol/profile` become `/api/{id}/profile`, and
  `/api/projects/export`, `/api/teams/export` and `/api/users/export` become the one route `/api/{id}/export`. The end
  of a path does not fold, and neither does a word with only parameters after it: `/api/projects/1`, `/api/users/2`
  and `/api/teams/3` stay apart.

  Limits: a one-word slug stays, even when an answer names it (`/api/users/alice` with `{"username":"alice"}`); a list of
  names at the end of a path stays (`/api/users/alice`, `/api/users/bob`, `/api/users/carol`); a sentence or a person's
  name of up to four parts keeps the form (`alice_smith_hiv_positive`); and a plain word used as a key, a form field or a
  query name stays unless it is or holds a secret. Read the draft before sharing it.

  A JSON response is parsed for its schema and its values and not kept: one that says it is over 1 MB is not read, and one
  with no `content-length` is read whole and dropped if it is over 1 MB. A JSON answer that never ends (a long poll, a
  watch stream) does not hold the run: after 3 s its body is cut off, the request is kept with method, path and status,
  and the run log says how many were cut off. Nothing is written when no API request was seen, when the requests make no
  operation, when more than 1 000 000 distinct values were seen (the log says why), or on the cli backend; a failed write
  goes to the log and the run goes on.

  A HAR (#228) follows the same rules as the traffic and keeps its host in the title and `servers`. A Postman collection
  keeps what a person wrote: its one host, its paths with `:id` and `{{id}}`, and its query names in any form (`?verbose`,
  `page[size]`, `filter[status]`, `$top`), with no fold by a value or by position. In a collection's path only digits, a
  credential-shaped word and an address are parameters, and what holds a secret is a parameter or left out; the keys of
  its bodies and examples pass the same name form as the traffic's. Instead of a text pass over the finished file, the
  name of a collection, a request or a folder that holds a secret as a run of whole parts is dropped whole.

- **Two-actor API security check: IDOR and privilege escalation (#233).** `cairn api --base-url <u> --actors <file>
  --allow-mutations`: the owner creates a resource through a saved API flow (#230), the other actor (a saved session or
  `{{env.NAME}}` headers) tries to read, change and delete it and reads the ids next to it; each 2xx is a finding tagged
  `WSTG-ATHZ-04` (another user) or `WSTG-ATHZ-03` (a lower role). Same guardrails as the rest of `cairn api`
  (`--allow-mutations`, `--allowed-methods`, `--allowed-paths`, budget, rate); the flow's cleanup runs in a `finally`.
  Only `401`, `403` and `404` count as refused; any other non-2xx answer is inconclusive and fails the run, and so is
  a check in which every answer the other actor got is a `401`, since its credentials may not be valid. The other
  actor's requests carry no identity but its own actor definition. From the flow file it takes only `Accept`,
  `Accept-Language`, `Content-Type` and `User-Agent`; its own headers and session cookie come from `actors.json`.
  Header names merge case-insensitively. A check refused before its first request has no cleanup. A cleanup step without
  `expect` is done only on a 2xx, and a `404` or `410` counts as already gone only when the other actor's `DELETE` of
  that resource went through; a cleanup that answers otherwise, or that cannot be sent because its value was never
  captured, is a cleanup error naming the request and the resource. A captured JSON whole number past 2^53
  stops the check, naming the capture: it may have been rounded, and a read or a cleanup must not reach another record.
  A string id above 2^53 is used as written, and its neighbours are skipped. Exit codes, the first that applies wins: `1`
  for a two-actor file or saved session that cannot be used, a finding, an inconclusive case, a check that stopped, a
  cleanup that failed, or a check `not tested` (it ran with no probe answered, or `--allowed-methods`/`--allowed-paths`
  refused its flow or cleanup) while another check got an answer; `4` for a check not started because the budget could
  not cover it; `5` when no probe in the run got an answer, because nothing was tested (the owner's own requests do not
  count); otherwise `0`. An error about a request says its method, its path and a category, never the text of the
  underlying error. A captured value is shown only as a whole number in the path, and not when it equals the value of an
  `{{env.NAME}}` the flow file or `actors.json` names; everything else stays as written, `{{name}}`, `{{env.NAME}}` and
  the whole query. What is known in advance is refused before the first request: a bad header name, a header value whose
  characters cannot be sent because of an actor's header or an `{{env.NAME}}`, and, anywhere in the flow's steps and
  cleanup, an `{{env.NAME}}` that is not set or that cannot stand in a path. What a captured value holds is known only
  when it is sent: a header with characters from one is refused then, naming the header. A URL that cannot be parsed is
  refused instead of sent. So a secret from the environment never reaches the report or the terminal, with two known
  limits: a whole number the server answered is shown unless it equals a value a file names, so a number that is a secret
  or part of one can be shown when neither file names that exact value (`007` echoed as `7`); and a neighbour hidden
  because it equals a named value, next to an id that is shown, tells what that value is.
- **`cairn api --spec` takes a Postman collection or a HAR file (#228).** The format is told from the content: a
  Postman collection (v2.x; v1 is refused with how to export v2.1), a HAR (`log.entries`), else OpenAPI as before. A
  collection or a HAR is converted to OpenAPI 3.0, saved as `openapi.derived.json` in the run directory (`--out`, else
  `runs/api-<id>/`, also without `--base-url`) and read from there like a written spec. Ids in a path become
  parameters (`/projects/123` → `/projects/{id}`; `:id` and `{{id}}` keep their names), query keys become optional
  parameters, request and response body schemas are inferred from the examples (types and keys, `required` only for a
  key in every example), and the document, each operation and each inferred schema carry `x-cairn-derived: true`.
  From a HAR only the API requests of the origin most of them went to are kept; pages, scripts, styles, images, fonts
  and other origins are left out and counted in the output. No header, cookie, query or body value is written (only
  names, types and status codes), and the values of `Authorization`, `Cookie`, `Set-Cookie` and other sensitive
  headers, the secret-looking query, form, body and variable values (`decider/redact.ts`) and credential-shaped
  values are scrubbed from the file too.
- **`cairn view <runDir>` builds one offline HTML page for a run (#211).** It writes `view.html` into the run
  directory: the scenario video (a relative path to the local `.webm`) and the steps from `screencasts.json` as
  chapters; a click or Enter on a step seeks the video, the current step is marked, light and dark. A run with no steps
  shows the video and a note; a run with no video exits non-zero. `--open` opens it in the browser.
- **A click records its effect, and a failed click names its cause (#224).** On the lib backend `act()` now returns
  `outcome` beside `ok` (which still means the click was made): `navigated`, `opened-tab`, `downloaded`,
  `overlay-opened`, `overlay-closed`, `state-changed` (the element's state, the focus or the scroll),
  `content-changed` (a toast gone again counts), `network-only`, `unknown` (the page could not be read, or its next
  page is still on its way) or `no-effect` for a click that happened, and `intercepted`, `not-visible`, `not-enabled`,
  `detached`, `not-found` or `timeout` for one that failed, read from Playwright's call log instead of a bare timeout.
  `effect` holds the record: the URL, the new tab, the download, the dialogs and menus that appeared or went away, the
  ARIA snapshot diff, the texts that appeared, the element's checked / expanded / pressed / selected, the focus, the
  scroll, and the same-origin requests the click started (method, path with the query keys only, status; no bodies,
  no headers, no query values, credential-shaped path segments replaced). Requests of any origin are waited for up to
  2 s; the page's own polling is neither waited for nor recorded. A click that looks dead is read again for up to
  1.2 s before it is called `no-effect`. The probe keeps each click's outcome; its reverting click and the sign-in
  click are not watched (`watch: false`). `explore` and `design` write the requests to `requests.json` and the clicks
  with no change seen to `report.json` (`deadClicks`, `[]` when none, absent on the cli backend); `report.md` has a
  *Dead clicks* section to check by hand, which says what Cairn cannot see and leaves out links the crawl followed. A
  watched click takes about 250 ms longer, one that looks dead about 1.3 s. Prompts, generated files and existing
  `report.json` keys are unchanged.
- **`cairn api --base-url <url>` without `--spec` looks for a spec the server already serves (#227).** It tries
  `/openapi.json`, `/openapi.yaml`, `/swagger.json`, `/v3/api-docs`, `/v2/api-docs`, `/api-docs`,
  `/swagger/v1/swagger.json` and `/docs/openapi.json` on the base URL's path (its query string kept), in that order,
  and takes the first answer that reads as an OpenAPI 3.x spec (JSON or YAML, whatever the content type); the output
  names the address (`✓ OpenAPI spec found at …`) and the run goes on as if that spec had been given. The eight lookup
  requests are `GET` only, with no body and a 5 s deadline each; they count against `--max-requests` and `--rps`, do
  not follow redirects, need `GET` in `--allowed-methods` when that is given, and carry the run's headers (`--header`,
  api-scope knowledge, Basic auth from the URL; never an `X-HTTP-Method-Override`-style header). A path that
  `--allowed-paths` does not allow is skipped, not requested. A found spec's external references are not followed: a
  served spec whose `$ref` points at a file or another address is not used (`external $ref is not followed for a spec
  found on the server`) and the next path is tried. The Guardrails section counts the lookup's own requests
  (`spec lookup: N requests`), and `report.json` keeps what each address answered. When nothing is found the run exits
  `1` (`4` when the request budget ran out first), lists every address tried with what it answered and every address
  skipped, and suggests `--spec <path|url>`. A spec behind a sign-in is reached with `--header` (for example a
  `Cookie:` header) or the api-scope credentials; a `--session` option is not part of this change. `--spec` is no
  longer mandatory; without it and without `--base-url` the command still refuses, now naming both flags.
- **Saved API flows as Playwright fixtures for UI test setup and cleanup (#230).** An API flow is a named chain of
  requests in a JSON file (`version: 1`): its steps, the values it `returns` (for example `projectId`), and a `cleanup`
  that deletes what it created; `{{name}}` takes a captured value, `{{env.NAME}}` an environment variable when the
  test runs, `{{uid}}` a unique value. `cairn api --spec <s> --scenarios --save-flows <file>` saves each scenario
  chain that has a `DELETE` as a flow (create step → the id the `DELETE` needs → the `DELETE` as cleanup), keeping the
  flows already in the file. `cairn api --flows <file>` writes `api-flows.fixture.ts` (into `--out`), which exports
  `test` extended with one test-scoped fixture per data flow and `expect`; the cleanup runs in a `finally` after the
  test, also when it failed. A `kind: "signin"` flow signs in through the API and replaces the tests' `storageState`
  with the cookies it got. A data flow that changes data needs a cleanup, and runs only against an origin allowed
  explicitly (`--base-url <url> --allow-mutations`, or `CAIRN_ALLOW_MUTATIONS=<origin>` when the tests run); otherwise
  the test that asks for it is skipped and nothing is sent. A secret written into the file instead of `{{env.NAME}}`
  is refused. `design --flows <file>` writes a data or sign-in precondition as `API flow <name>: …` instead of UI
  steps; `automate --flows <file> [--allow-mutations]` sends the cases' preconditions and the flows to the codegen and
  writes the fixture module beside the specs. Neither command sends a request for a flow, and without `--flows` the
  prompts are unchanged. See `docs/api-flows.md`.

- **Overlays are explore states: dialogs, drawers, menus and wizards (#225).** `explore` and `design` now press a
  button that says it opens something (`aria-haspopup`, `aria-expanded` or `aria-controls`, read from the element);
  every other button is listed in `skipped` with the reason and never pressed. The invariant: exploring overlays
  changes nothing on the server, whatever the button is called, not while it runs and not after it ends. The lib
  backend holds it on the network: exploration presses in a throwaway browser made from the crawler's storage, which
  aborts every request whose method is not GET, HEAD or OPTIONS — form posts, fetch and XHR writes, beacons — and lists
  each one it stopped, with the element pressed before it, in `overlays.json` (`guard`, `blocked`) and `report.md`. At
  the end, also on an error, that browser is killed with the guard on, so nothing it did can reach the server later,
  and nothing flows back: the crawler's own page never saw a press. One exception, on `--channel` (full Chromium) over
  HTTPS: with `Reporting-Endpoints` and a CSP `report-to`, the browser's own Reporting API report goes out as a POST. It
  is not the app's doing, and it is not in `blocked`. Not seen: a WebSocket message, a GET that changes the server. Not
  checked: Network Error Logging. A backend that cannot guard the network (cli), or a guard that did not start, presses
  no trigger and no wizard step there; it reads the overlays already open and says why (`note`). With nothing to press,
  no second browser is started. On top
  of the guard, for every press (triggers, nested probes, a wizard's Next and Back): no element that submits a form (a
  submit button or a `<button>` with no type inside a form or joined to it by `form=`), nothing disabled. Names are
  kept only where the guard cannot see: a deletion or a sign-out, which is often a GET link («Close account», «Sign
  out», «Delete»), and a completion (Save, Submit…). There is no list of payment or order names: the guard stops
  what such a button sends, and «Sort order» or «Purchase history» are explored like any trigger. A wizard's Next and Back are whole names: «Next», «Next ›»,
  «Далі», «Назад»; «Next: place order» is no step. Each overlay found is recorded, in
  stack order (page → overlay → nested overlay), in `overlays.json` and `report.json` (`overlays`) and as an *Overlays*
  section of `report.md`: its kind (`dialog`, `alertdialog`, `drawer`, `menu`, `listbox`), what opened it, its
  elements, its exits and the wizard steps in it. Detection is deterministic and reads the ARIA snapshot only: a
  `dialog` or `alertdialog` is an overlay; a `menu`, `listbox` or `complementary` is one when it was not on the page
  before the click; `status` and `alert` texts (toasts, validation messages) are recorded, never states. Exits are
  read from the buttons (a close button and Cancel only by their whole name — «Close», «×», «Cancel», «Not now»,
  never «Close account» or «Cancel subscription»; Submit is marked destructive when the existing filters refuse its
  name) and probed for Escape and a click outside (`verified`). The click outside is made only at a point checked
  first: the element there lies outside the overlay and is no link, button, field or other control; when there is no
  such point it is recorded as not tried (`notTried`). A dialog is a wizard only when it has a Next and a Back or a
  step indicator («Step 1 of 3», a progressbar); an `alertdialog` never is, and «Continue» is no Next. Its Next and
  Back are pressed, each only when enabled, passing the filters and not submitting a form, to list its steps; Back is
  read from the step that shows it and pressed once to check it returns to the step before; where Next is blocked the
  page's message is recorded, the empty fields are filled once and Next tried again. Nothing is submitted. Elements inside a dialog now carry its scope, so their locator is
  `getByRole('dialog', { name }).getByRole(role, { name })` (in `act`, `verify`, `getState`, `report.md`, the
  interaction map and the codegen prompt), and a same-named element on the page is not confused with them. While a
  modal overlay is open (`aria-modal`, a native `showModal()` dialog, an `alertdialog`), `act()` does not click an
  element under it: it answers `ok: false, outcome: "under-overlay"` instead of waiting out a 30 s timeout; a dialog
  the DOM says is not modal (a cookie banner) leaves the page live. The lib backend gains two actions, `press` and
  `click-outside`; the cli backend refuses them. The design prompt asks for the state-transition set per overlay
  (open, cancel, Esc, save valid, save invalid, nested confirmation, wizard steps), the codegen prompt makes each
  overlay its own component object. One worker-tier LLM call gives each overlay a short purpose for cases and docs; it
  never decides what an overlay is. On by default; `ExploreDeps.overlays: false` turns the step off. A page-level
  wizard (not inside an overlay) and a side panel that stays on the page from the start are not found yet.

- **Click only what is visible and unique in its scope; no blind `.first()` (#226).** On the lib backend `act()`,
  `verify()` and `getState()` look in the current scope (the dialog, #225) among the visible elements only. One match:
  it is the element. Several: they are narrowed by the accessible name of the row, list item, card, section or form
  the element sits in, nearest first, taking the first container after which exactly one is left
  (`getByRole('row', { name: 'Jane Roe Delete', exact: true }).getByRole('button', { name: 'Delete', exact: true })`);
  `verify()` then marks the element `verified` with `narrowedBy`. Links with the same name that all lead to the same
  address are one destination and are followed. When nothing narrows them the element is `ambiguous`: `act()` answers
  `ok: false, outcome: "ambiguous"` with `ambiguous: { role, name, count }` and clicks nothing, `verify()` returns
  `ambiguous: true`, `getState()` reads nothing from a guess, and the run report lists it: `report.json` (`ambiguous`)
  and a *Ambiguous elements* section of `report.md`, which names the likely accessibility problem (identical names
  with nothing to tell the controls apart). `verify()`'s `count` is now the number of visible elements, not of all.
  The design and codegen prompts no longer say `(×N — repeated, .first())`: an element a row narrows carries that
  locator, an ambiguous one is marked «do not click it», one with no narrowing known is told to narrow by context. The
  codegen rule «ALWAYS use `.first()`» is replaced by «narrow by context; `.first()` / `.nth()` only with a comment
  saying why the position is the point of the check (for example sorting)», and the interaction map no longer appends
  `.first()` to a repeated element's locator. Generated code is linted before it is run (`lintErrors`): `page.mouse.click`
  (also through an alias such as `const m = page.mouse`), `force: true` (also as a quoted key, `!0`, or the shorthand
  of a variable set to true that a spread carries), and `.first()` / `.last()` / `.nth(` (also `['first']()` and
  `>> nth=` / `:nth-match(` in a selector) without a comment on its line or the line above are errors; a `// TODO`,
  `FIXME` or a tool directive is no reason. The file is read whole, so a regex with an apostrophe or a template over
  several lines no longer hides the code after it; a suite with
  one is not run, each error becomes a failed result that goes into the repair loop like a failing test (the hint,
  the no-progress stop, keep-best), in `explore`, `design` and `automate`. Words in strings and comments are not read
  as calls. Counted over the fixture pages (what Cairn puts into generated code or tells the generator to write: the
  interaction map's locators, the `.first()` hints of the codegen and design prompts, the writer prompt's rule): on the
  pages that were there before, 0 hints and 1 rule before, 0 and 0 after; on the two new pages with repeated elements
  (the three-row table, two identical buttons and two identical links) 7 map locators, 7 + 7 prompt hints and 1 rule
  before, 0 after.
- **`cairn mcp` tells the client what each tool does, and returns structured results.** `explore`, `design` and
  `automate` carry tool annotations set from what the code does: none is read-only, all reach an open world (models,
  the target site), none is idempotent, and only `automate` is destructive (it replaces the `tests/` folder of the run
  it is given). The descriptions say that each call is paid and which folders it writes, and what `intoProject` and
  `validate` do. Each tool has an `outputSchema`, and its result comes as `structuredContent` as well as the JSON text.

### Changed

- **`cairn mcp`: `decider`, `routing` and `backend` take only their known values.** The input schemas list them as an
  `enum` taken from the configuration (`decider`: `off`, `jev`, `laya`, `compat`; `routing`: `volume`, `volume-fast`,
  `fast`; `backend`: `lib`, `cli`). An unknown `routing` used to print a warning and run without a preset; it is now a
  validation error, as is a `decider` in upper case, and the call does no work. The CLI and the environment variables
  are unchanged.
- **`cairn mcp` serves both protocol eras.** A client that opens with `initialize` gets the revision it asks for
  (2025-11-25 down to 2024-10-07), as before; a 2026-07-28 client, which sends no handshake and may probe with
  `server/discover`, now gets 2026-07-28 instead of «Method not found». The first message picks the era for the
  connection. The tools, their hints, closed values and structured results are unchanged; their schemas now name the
  JSON Schema 2020-12 dialect instead of draft-07, and `execution.taskSupport: "forbidden"` (the default) is no longer
  listed. The optional package is now `@modelcontextprotocol/server` (`npm i @modelcontextprotocol/server`) instead of
  `@modelcontextprotocol/sdk`; without it `cairn mcp` says what to install on stderr and exits with code 1.

### Fixed

- **Overlay exploration reports what happened, not more and not less (#252).** A press whose request the write guard
  stopped is no longer a dead click: its outcome is `unknown`, since what the page would have done with the answer is
  not known, and the stopped request is in `blocked` only, not in `requests.json`. A site that replaced a session cookie
  (`httpOnly`) the crawler holds while the pressing browser read its pages now says so in `note`: on a site that ends
  the old session, the rest of the run is signed out. A button that shares its role and name with another one nothing
  tells apart is skipped for that reason (it was `could not be read as visible`), and inside an overlay it is in the
  run's ambiguous elements too. An overlay's elements that repeat are written through their row, card or section. In
  validation, a test's error counts as a missing browser only when it starts with the launch's own error, so a page
  titled «playwright install | Docs» no longer stops the run; every project and every retry of a test is read.
- **A captured number that `JSON.parse` changed is no longer sent, by the fixture or the two-actor check (#253).**
  `9007199254740991.4` and `3.0000000000000000001` read as safe integers, so `cairn api --actors` sent another number in
  the path than the server answered, and a read or a cleanup could reach another record. The check now compares each
  captured number with the text the server wrote and stops, naming the capture, when they differ. The written
  API-flow fixture kept every captured number as it was read, `1e400` and numbers past 2^53 too; it now refuses them by
  the same rule, failing the step and keeping the answer's other captures, so the cleanup still goes to the created
  record. A whole number written another way (`3.0`, `30e-1`) is still taken as the number it is.
- **A template in a key of a flow file is refused when the file is read (#253).** Only values are filled, so a key
  such as `query: {"{{nope}}": "1"}` went out as written from the two-actor check, while the written fixture read it as
  a missing value and silently left that cleanup step out, leaving the record. The fixture now reads values only.
- **A failed test's request log no longer stays on disk after validation (#256).** Playwright writes each failed
  test's error into `error-context.md`, and for a request the test sent itself that error is the whole call log:
  the URL, `Authorization`, `cookie`, `set-cookie`. Validation now gives Playwright an output folder inside the run
  (`runs/<id>/test-results/`, or `runs/<id>/screencasts/` with `--screencast`, as before), so a run no longer writes
  `test-results/` beside the project's `package.json`, and after each run it drops the request's log from every
  `error-context.md` there by the same rule as the failure texts (#250), keeping each status. The page snapshot, the
  test source and the video stay.
- **API-flow fixture errors, repair hints and session file errors no longer repeat a value (#250).** The written
  fixture named a value that cannot stand in a path by printing it (`{{env.SEG}} is "sec/…"`), and let a failed request
  throw Playwright's own text, whose call log holds the full URL and every header. It now names the template as written,
  and says `got no answer:` with a code, `timeout` or `network error`. `cairn automate --flows --validate` masks the value of
  every `{{env.NAME}}` the flow file names in the failure texts it hands to the repair hint, the triage and the report,
  and keeps no trace beside a `--screencast` video. Validation drops the lines of a request's log (`→ POST <url>`, the
  headers) from the failure texts, also where a test carried them on in a diff or indented, and keeps each status
  (`← 401 Unauthorized`); a locator's call log stays, since it names the locator. A session file that cannot be read, is
  not JSON or has a cookie with no name, value or domain gets one line that names the file and a fixed reason, instead of
  `Unexpected token 'C', ..."value":COOKIE…` with no file name or `Cannot read properties of undefined`, and
  `automate --validate` reads the file first: it stops there, before a call to the model or a test. A flow file or a
  two-actor file that is not JSON no longer repeats a fragment of its text either.

- **A pull request that mentions `playwright install` no longer reads as a missing browser.** On GitHub Actions the
  Playwright report holds the pull request's title and diff, and the check for a missing browser read the whole report:
  a title or a changed line with `playwright install` or `Executable doesn't exist` stopped the run with
  `BrowsersNotInstalledError`, every browser in place. Now it reads what the run said (stderr, the report's errors, the
  tests' errors).

- **`cairn api --actors` stops only for what it would send, and carries out its cleanup (#251).** A capture that no
  request sends no longer stops the check, whatever the answer holds there (a number past 2^53 such as a timestamp, no
  value, no JSON at all). A template in a step's `name` no longer keeps a cleanup from going out and the record from being
  deleted; the written fixture had the same fault and left such a step out without a word. A captured `1e400`, which
  parses as `Infinity`, now stops the check instead of going out as `DELETE /api/projects/Infinity`. A `{{uid}}` in the
  flow file's or an actor's headers goes out as one value for each check instead of being refused.

- **`cairn api --spec <url>` reads a spec on a local or private address, and a refusal says what happened (#234).**
  The address is no longer handed to the parser's own downloader, which refused `127.0.0.1`, `localhost` and private
  networks and reported it as an unresolved `$ref`. The text is read the way the lookup of #227 reads it: `GET`, no
  body, no redirect, a 15 s deadline, one request of the run's budget through the shared guard (`--allowed-methods`
  without `GET` sends nothing). The run's headers (`--header`, api-scope knowledge, Basic auth from `--base-url`; never
  a method-override header) go with it only when the spec is on the `--base-url` origin, or when there is no
  `--base-url`; a spec on another origin gets none of them. A refusal names the status, the redirect that was not
  followed and where it pointed, or the timeout, and for `401`/`403` says to pass `--header`. A `$ref` on the spec's
  own origin (a multi-file spec on a dev server) is read the same way, one request each; a `$ref` to any other origin
  or to a local file is never fetched, so neither a redirect nor a host name that resolves to a private address
  turns the named spec into another read.
- **`cairn api --base-url` with a query string no longer sends every case to the server root (#235).** The request URL
  is now built from the parsed base URL: the case path follows the base path, the base query (a signed address, a key
  in a parameter) is kept on every request and the case's own query parameters are added to it. A base URL without a
  query is joined as before; the host and base-path checks run on the built address.
- **A spec given as `--spec <url>` no longer reads local files (#227).** A `$ref` such as `file:///…/secret.json` in a
  downloaded spec was read from disk, and its content could end up in the requests sent to the target; a remote spec's
  `$ref`s now resolve over http(s) only. A spec file on disk still reads the files it references (multi-file specs).
- **An element whose name has quotes is found again (#238).** The ARIA snapshot escapes a quote inside a name
  (`- button "Say \"hi\""`); the name was cut at the escaped quote (`Say \`), so the element's locator found nothing
  and a click on it ended `not-found`. The name is now read whole and unescaped. An element whose name has `: `, ` #`,
  `{`, `}` or a backtick (`Price: $5`) is no longer skipped: the snapshot wraps its whole line in single quotes
  (`- 'button "Price: $5"'`), and such a line was not read as an element at all.

## [0.9.0] - 2026-10-29

### Added

- **`--screencast` keeps a Playwright trace beside each video (#210).** The validation config now records
  `trace: 'on'` next to `video: 'on'`, so `runs/<id>/screencasts/` holds a `trace.zip` per scenario, and each
  `screencasts.json` entry names it in `trace` (relative to the run dir, with `/`). A trace weighs about six times the
  video: 2.19 MiB against 359 KiB for four scenarios on a local Plune stand (plune-ai/plune#1880). Runs without
  `--screencast` are unchanged. A run with a session, Basic Auth, environment secrets or a mailbox keeps the video
  alone: Playwright writes the Basic Auth password in the clear, every request's headers and cookies and every typed
  value into a trace. With a trace the video moves at about 5 frames a second between actions (Playwright 1.61 holds
  each frame up to 200 ms for the trace, except for 500 ms after an action).

- **Test mailbox and TOTP for browser scenarios (#206, ADR-0023).** A `MailsacProvider` configured only from
  `MAILSAC_API_KEY` (plus optional `MAILSAC_ADDRESS` / `MAILSAC_DOMAIN`) and a `MailboxSession` with the steps
  `mailbox.create`, `mailbox.waitFor`, `mailbox.extractLink`, `mailbox.extractCode`, `mailbox.openLink` and
  `totp.code` (secret read from a named environment variable). Addresses, extracted links and codes and the TOTP
  secret are registered as secrets and masked in progress, `run.log` and validation errors. Off by default:
  `ExploreInput.mailbox` is absent unless passed, and existing scenarios are unchanged. See `docs/mailbox.md`.

- **Environment description for browser runs: Basic Auth → login → start path → scenario (#204).** `explore`,
  `design` and `automate --validate` take `--env-file <path>` (or `CAIRN_ENV_FILE` / `CAIRN_ENV_*`) with `baseUrl`,
  optional `basicAuth`, optional `user` and `startPath`. The stages run in that fixed order and a stage without
  input is skipped. Secrets are read only from the environment variables the file names and are masked in logs,
  reports and errors; a failed stage is reported as `Basic Auth rejected`, `Login failed` or `Start page
  unreachable`. Runs without the new flags behave exactly as before. See `docs/environment.md`.

### Changed (breaking)

- **`cairn api --base-url` no longer sends mutating requests unless `--allow-mutations` is given (#196).** A run
  that used to execute every generated `POST`/`PUT`/`PATCH`/`DELETE` now lists them as
  `skipped: mutations disabled`, and a run in which nothing at all could be sent (a spec with only mutating
  operations, `--allowed-paths` matching nothing) fails with exit code `5` instead of reporting `0/0 passed`.
  Add `--allow-mutations` to restore the old behaviour against an environment you own. The same change brings the
  rest of the guardrails below, all on by default (`--max-requests 300`, `--rps 5`, pinned host, no redirects).
- **`cairn api --base-url` is safe by default: guardrails on what is sent (#196).** A run against a target could
  send any generated `POST`/`PUT`/`PATCH`/`DELETE`, follow redirects and send as fast as the target answered. Now
  mutating cases are generated and listed but not sent unless `--allow-mutations` is given (reported
  `skipped: mutations disabled`, with their count); the `psycho` and `hacker` styles need it explicitly.
  `--allowed-methods` and `--allowed-paths` (masks) skip everything outside the lists as `not allowed`;
  `--max-requests` (default 300, retries counted) stops the run and exits with code `4` when spent, the rest
  reported `skipped: budget exhausted`; `--rps` (default 5) limits the whole run whatever the concurrency. Requests
  always go to the `--base-url` host (`servers` from the spec are ignored), redirects are recorded and not followed,
  and a path parameter that is or decodes to a `..` segment is refused instead of leaving the base path; payloads
  inside values still go out. Tokens passed as headers are masked in the console, evidence, reports and in response
  bodies that echo them. The report gains a guardrail summary (executed / skipped by reason / blocked, budget used).
  Without `--base-url` (cases only) nothing changes; with it, the defaults above apply, so a run that relied on
  mutations needs `--allow-mutations`.
  With `--base-url`, coverage is computed from what was actually sent: a case that was skipped or blocked does not count
  as covering its operation, so `--min-coverage` can fail on a run without `--allow-mutations` (the mutating operations
  are then uncovered).

### Added

- **`cairn api --min-coverage <percent>` fails CI when the spec is under-covered (#197).** The share is the
  `covered` operations over all operations of the spec; `partial` operations count only with `--count-partial`.
  Below the threshold the run prints `n / N`, the percentage and the operations that are not counted (uncovered and,
  without `--count-partial`, partial; a spec with no operations passes at 100%), writes the verdict to
  `report.json` (`coverageGate`) and `report.md` for runs with `--base-url`, and exits
  with code `3` (`1` stays a failed test or a bad input; a value that is not a number from 0 to 100 is rejected
  with a message). The GitHub Action gains `api-spec`, `min-coverage` and `count-partial` inputs that run
  `cairn api` with the flags. Without the flag nothing changes.

### Fixed

- **Screencast chapters start where the step is in the video, in a run without credentials (#214).** A chapter's `atMs` was the sum of the step
  durations before it, while the `.webm` starts at the browser's first frame: in the first scenario of a worker, whose
  hooks launch the browser, chapters ran up to seconds late and could point past the end of the video. The offsets now
  come from the trace - each step's start against the first frame's swap time, the clock Playwright places video frames
  by - and a step that began before the first frame sits at 0. An entry says which it has in `timing`: `trace`, or
  `estimated` when there is no trace (a run with credentials), or it is unreadable, lists other steps or holds no
  frame (a scenario of a few milliseconds). An estimate is the old sum and in the first scenario of a worker can
  still run seconds late. A `screencasts.json` written before has no `timing`: read it as `estimated`.

- **The TUI names a timed-out LLM step as itself, with its advice (#194).** A step past `STEP_TIMEOUT_MS` showed as
  `Failed: unknown` after `explore` or `design`, and after `automate` - whose error reaches the TUI unwrapped and
  names the Anthropic profile - as `Failed: config` with advice to check an API key. It is now `Failed: llm-timeout`, told by the same check the CLI's run summary uses, with the advice to try
  `--routing volume-fast`, `LLM_PROFILE=anthropic`, or a higher `STEP_TIMEOUT_MS`.

- **`report.json` of a `design` run keeps `testCaseFiles` relative to the run dir (#219).** It stored the absolute
  paths of the machine that ran it (on Windows with backslashes), so a run dir copied to a CI artifact or into Plune
  pointed nowhere. The report now has `testcases/ATC-….md`, with `/`, like `video` in `screencasts.json`. The
  `testCaseFiles` of the `runDesign` result, which the CLI and MCP print, stay absolute. The field keeps its type,
  and no reader in the Plune line opens these paths, so `schemaVersion` stays 1: `plune ingest` refuses any
  version it does not know. Reports written before this fix keep their absolute paths under the same
  version, so a reader that opens these files should check `isAbsolute` first.

- **The `openrouter` profile no longer names models OpenRouter has retired (#212).** Its reasoning model
  `deepseek/deepseek-r1` answered `404 ... is no longer available on OpenRouter`, so every run on the profile failed
  on its first design call; it is now `deepseek/deepseek-r1-0528`, the R1 successor that OpenRouter serves. The vision
  model `qwen/qwen-2-vl-72b-instruct` had become an alias of `qwen/qwen2.5-vl-72b-instruct`, and the profile now names
  that model directly. The default price table follows the OpenRouter list of 2026-10-29 for both, and a test fails when
  a profile or a routing preset names a model the table does not know, or either of the two retired ids.
- **`screencasts.json` names each video with `/` on any OS (#214).** On Windows the path was written with
  backslashes (`screencasts\login\video.webm`), which a reader on another OS cannot resolve. The chapter offsets
  are unchanged here: they still count from the first step, not from the video's first frame (#214, with #210).
- **`probeInteractions` has an end, and says how far it got (#213).** After `exploreStates` the step was handed the
  elements of the views it had opened, while the page was back on the first one; reading the state of a checkbox or
  switch that is not on the page waited Playwright's 30 s default, element after element, which is how a page of
  views could go quiet in `run.log` for 13+ minutes. The state of an element that is not visible is no longer read
  (and a visible one is read for at most 2 s); a probe click waits at most 2 s. An element that still does not
  answer within 15 s is skipped with a line in the log; no new element is started after 2 minutes, and the log says
  how many were tried; a progress line comes every 10 safe elements.
- **The destructive-action filters know Ukrainian and Russian, not English only (#185).** The crawler's
  destructive-link filter and the deletion-intent check matched English words, so on an app in another language
  neither refused anything: `--flow` followed a link named `Вийти`, which can end the saved session mid-run, a
  precondition worded `Видалити всі наявні елементи` was seeded instead of left to a human, and `locator-heal` could
  offer `Видалити акаунт` as a replacement. Both now refuse the Ukrainian and Russian words for log out, delete, remove,
  deactivate and close account (the crawler) and for delete, remove, clear and reset (the deletion-intent check),
  each as a whole word in the form a button or a step uses. A name that only shares a root is not refused:
  `Видалені елементи` (Deleted items), `Удалённый доступ` (Remote access), `Вихідні дані` (Output data). English
  is matched as before; a control named in any other language is still offered like any other.
- **A timed-out LLM step is reported as itself, not as a page that could not load (#181).** The per-step timeout
  (`STEP_TIMEOUT_MS`) fails with "timed out", and a failed run whose error said "timed out" was filed under
  navigation: a run whose page had loaded and whose model then ran past the limit ended with "Could not load the
  page" and the advice to check the URL. It now says that an LLM step timed out and gives the advice that applies,
  a faster `--routing` or a higher `STEP_TIMEOUT_MS`; `page.goto` timeouts and `net::ERR_…` errors are still reported
  as navigation failures. A failed run also keeps its cause and its progress: `report.json` gains `errorDetail`, the
  error's own first line, beside the friendly `error` (for a timed-out step it names the role and the model and how
  long the step waited; `schemaVersion` stays `1`, the key is only added), and `run.log` keeps the progress lines the
  run had written and ends with the summary, where the summary used to replace them.

## [0.8.0] - 2026-09-24

### Added

- **An optional decision layer (`DECIDER`, [ADR-0022](docs/adr/0022-optional-decision-layer.md)) — the
  seam, off by default.** A System One model — TypeSafe **Jev** in the cloud, **Laya** on your own machine
  via `laya-serve`, or any Jev-compatible server — can answer the pipeline's pick-from-a-list questions. The
  layer itself: configuration (`DECIDER`, `DECIDER_*`, `--decider` on `explore` / `design` / `automate` and
  the MCP tools; each provider reads only its own address and key — jev the TypeSafe SDK's
  `TYPESAFE_BASE_URL` / `TYPESAFE_API_KEY` pair, and only an `https://*.typesafe.ai` address), one bounded HTTP client
  (limits on the state and question checked before sending, one timeout, one retry, a per-run ceiling),
  best-effort secret scrubbing of everything sent, a `decider` row in the cost ledger, Langfuse spans, and a
  `cairn doctor` section that makes one real call and says where the data goes.
  With `DECIDER` unset a run is byte-identical to a run without the layer, and a provider key alone enables
  nothing. Guide: [`docs/decider.md`](docs/decider.md).
- **Two decider use points, and a shadow mode to judge them first.** `repair-triage`: a confident "the app
  is broken" or "the environment is broken" keeps a failing test out of the repair hint — repairing test code
  cannot fix either — and the run lists it under *Not repaired* (`report.json` `notRepaired`, `report.md`, the
  `automate` output); every other confident category only tags the hint, and when *every* failure is excluded
  the loop stops without spending an attempt; an exclusion holds only while the test fails the same way.
  `coverage`: the checklist × case matrix as yes/no answers replaces the LLM coverage judge when every item
  gets a confident verdict (the score's comment names the decider), and falls back to it otherwise.
  `--decider-shadow` (`DECIDER_SHADOW=1`) asks the decider at every enabled use point, records its answers
  next to what the run actually did in `runs/<id>/decider-shadow.json`, and changes nothing else. An active
  `explore` adds a `decider` summary (calls, fallbacks) to `report.json` and a *Decision layer* section to
  `report.md`, and `design` adds the summary to `report.json`. `automate` writes no report: it prints both, and its
  MCP tool returns `decider` and `notRepaired`. By default an active decider consults `repair-triage` alone and shadow mode asks every use point:
  `coverage` answered confidently wrong on laya's multilingual checkpoint, so it acts only when named in
  `DECIDER_USES`. A run in which no enabled use point can fire (no checklist, no repair loop) does not start the
  layer: no data notice, no report key, no shadow file.
- **A third use point, `locator-heal`: a verified replacement for a broken locator, offered to the repair.**
  It starts when triage confidently calls a failure a locator failure and the error names a `getByRole(…)`.
  - Cairn reopens the start page, and the decider picks the element the locator meant, or `none-of-these`. The
    candidates are the page's elements of the same or a compatible role, never one the destructive-action filters
    refuse. Those filters match English words only (#185).
  - A pick the browser matches exactly once joins the test's repair hint:
    `→ replace <old> with getByRole(…, exact: true) (verified: 1 match)`. The repair still writes the code. Tests
    that miss the same named element share one heal. Which of several matches a test meant is asked per test.
  - Every proposal behind the kept suite is listed: `report.json` `healed`, a *Locators healed* section in
    `report.md`, the `automate` output, its MCP result and the TUI summary. The TUI summary now also lists what the
    decider kept out of repair, which it did not show for an `automate` run.
  - It acts only when named (`DECIDER_USES=repair-triage,locator-heal`; without `repair-triage` it is an error)
    and needs the `lib` browser backend.
  - Shadow mode asks it on every verdict triage would have given, and records whether its pick matched once.

### Documentation

- **The decision layer across the docs.** [Langfuse](docs/langfuse.md) lists the `decider.<use>` spans (a
  fallback is a `WARNING` span with its reason) and the `decider.<use>.confidence` / `.agreement` scores;
  [MCP](docs/mcp.md) the `decider` parameter of `explore`, `design` and `automate`;
  [decider.md](docs/decider.md) laya-serve's `LAYA_MODELS`, the latency to expect on a CPU against the default
  `DECIDER_TIMEOUT_MS`, and where each command reports the layer; the README links the guide. ADR-0022 gains a
  latency record for both laya checkpoints on a CPU, with twelve labelled triage questions sent together as a
  failing suite sends them.
- **The architecture overview no longer calls Cairn single-page:** `--flow` (ADR-0017) follows in-app
  navigation for up to `--max-pages` pages, and the decision layer is listed among the technology pillars.
- **`.env.example` lists the decision layer's variables**, commented out with the defaults the code uses: an
  empty `CAIRN_TYPESAFE_BASE_URL=` counts as set, so an uncommented copy would change what `DECIDER=jev` needs.

### Fixed

- **A test that timed out lost the error that named its locator.** When a click or a fill waits for an element
  that never appears, the test's own timeout fires first. Playwright then reports the timeout as the test's error,
  and the action's error, whose call log names the locator it waited for, comes second. Validation kept only the
  first, so a repair saw `Test timeout of 30000ms exceeded.` and nothing about which locator failed. Every
  error is now kept, once each: in the repair hint, in what repair triage reads, and in `explore`'s `report.json`
  validation results. The code frame and the stack lines Playwright appends to each error are left out: they carry
  the spec's absolute path, and with it the machine's user name. A failure with a single error reads as before,
  minus any stack lines.

## [0.7.0] - 2026-07-30

### Added

- **The run artifact is now a versioned, self-describing contract.** `report.json` carries
  `schemaVersion` (currently `1`) in every shape it is written in — `explore`, `design`, `api`, and the
  partial one a failed run leaves behind. Anything that reads a Cairn run can now tell whether it is
  looking at a format it understands, instead of finding out by misparsing it.
- **Every artifact says which kind of run produced it.** `mode` was previously present only on `design`
  and `api`; `explore` and the partial artifact now carry it too. A reader no longer has to infer the
  kind of a run from whichever optional keys happen to be present — a guess that silently starts
  returning the wrong answer the moment a key becomes optional.
- **Cases carry `stableId`, a content-derived identity that survives a re-run**
  (`artifacts/contract.ts`), alongside the existing `id`. It appears in `report.json` and in the `.md`
  frontmatter, and `parseTestCaseMd` reads it back. The two answer different questions and both are
  kept: `id` numbers the case *within this run*, `stableId` says whether this is *the same case as
  last time*.

  The existing `id` is untouched, so `promote` and `automate` — which match on the `ATC-<suite>-<n>`
  shape — behave exactly as before.

  Scope, measured rather than assumed: identity is fully stable for spec-derived `api` cases (two runs
  produced 26/26 identical ids, including distinct ids for the positive and the negative case of the
  same operation). It is exact-content identity, so LLM-designed cases that get reworded between runs
  do not match — two `design` runs over the same page shared none. That is still strictly better than
  the positional id, which produced *false* matches; this one either matches truly or reports that it
  does not know. Similarity matching (`design/dedup.ts`) remains the tool for reworded cases.

## [0.6.0] - 2026-07-01

### Added

- **`cairn api` — adversarial testing styles (#95, BORROW-07).** New `--adversarial [styles]` flag —
  generates/runs cases in one or more of four named styles (bare flag = all; comma-separated to pick
  specific ones), taxonomy borrowed from testomatio/explorbot's Chief+Curler (explorbot's own styles
  are LLM-driven; only the taxonomy is ported, translated into cairn's existing schema-driven, no-LLM
  case generation): `normal` (the always-generated happy path, just tagged — no new cases), `curious`
  (exhaustive valid-data coverage: every parameter including optional ones, one case per additional
  declared enum value), `psycho` (invalid/malformed/extreme input: SQL-injection and XSS payloads in
  the first string body property, an extreme boundary value in the first numeric one, plus API-8's
  existing negative case re-tagged rather than reimplemented — payloads and OWASP WSTG test IDs
  harvested from AZANIR/qa-skills via BORROW-08/#96), and `hacker` (a deliberate subset: strips
  configured auth headers from an otherwise-valid request and expects rejection — `ApiCase.stripAuth`,
  honoured by the runner). Every generated case carries `adversarialStyle` + (where applicable)
  `wstgId`, flowing through the existing run/report/coverage/ATC pipeline unmodified — a distinct case
  category, not a parallel one. The coverage half of this issue's DoD needed no new code: API-6's
  `computeApiCoverage` is endpoint/status-driven, already covers however many cases target an
  operation. **Deliberately out of scope** (follow-up): `hacker`'s IDOR and privilege-escalation
  checks are genuinely stateful/multi-request in explorbot's own implementation (≥2 identities,
  resource creation + adjacent-ID probing, response-field replay) — closer to API-9's scenario-chain
  machinery than a single independent case, so only the deterministic auth-strip check ships here.

- **`cairn api` — `multipart/form-data` request encoding (#150, C1-04 / API-10).** The runner
  (`runner.ts`) now encodes a case's body as real `multipart/form-data` (boundary, per-part
  `Content-Disposition`, correct `Content-Type`) when the operation declares it, instead of always
  JSON-encoding — via Node's native `FormData`/`File` (undici), which generates the wire format
  itself rather than a hand-rolled encoder. Case generation (`cases.ts`) synthesises a `format:
  binary` property (e.g. a file-upload field) as a real in-memory `Buffer` instead of the literal
  string `"string"`, so a multipart body has actual file content to send. A new fixture spec
  (`tests/fixtures/api/multipart-upload.yaml`) exercises this end to end: generate → run against a
  mocked server → correct encoding asserted. Follow-ups (out of scope here): `--negative` (API-8)
  doesn't yet propagate `bodyMediaType` to its corrupted-body case for a multipart operation, and
  array-of-files (`items: { format: binary }`) synthesises only one file, mirroring the existing
  one-element array behaviour for every schema type.

- **`cairn api` — multi-endpoint scenario chains / journeys (#146, C1-04 / API-9).** New `--scenarios`
  flag: given the ingested spec, chains related operations on the same resource (a *collection* path
  like `/pets` plus an *item* path templated one level deeper, `/pets/{id}`) into an ordered
  create→read→update→delete scenario, using whichever of those the spec actually declares (a resource
  with no downstream op — nothing to read/update/delete a created resource with — gets no scenario).
  Each step is a normal API-2 happy-path case; the runner (`scenario-runner.ts`) threads a value
  captured from an earlier step's response into a later step's matching param — preferring a declared
  OpenAPI `links` expression (`$response.body#/...`) when the spec has one, falling back to a
  same-named response-body field otherwise. A failing step aborts the rest of the scenario (its
  remaining steps are recorded, not silently dropped, with a `skipped —` reason) rather than
  cascading one real failure into several meaningless ones. Per-scenario (and per-step) pass/fail is
  reported alongside the existing per-operation results: a new stdout section, `report.json`'s
  `scenarios` field, and a `## Scenarios` section in `report.md`. Opt-in, so the existing default
  (1 case per operation) is unchanged for everyone not passing the flag. Follow-ups (out of scope
  here): scenario steps aren't folded into the spec-vs-tested coverage report or ATC `.md` docs, both
  of which are shaped around single operations today.

- **`cairn api` — stricter contract validation + negative-schema cases (#145, C1-04 / API-8).**
  Response-schema conformance now goes through `ajv` (+ `ajv-formats`) instead of the hand-rolled
  structural checker: `format`/`pattern`/`minimum`/`maximum`/`additionalProperties` are now enforced,
  not just type/required/properties/items/enum/allOf/oneOf/anyOf. Circular schemas from swagger-parser's
  dereference (e.g. `Pet.friends -> Pet`) are de-cycled before compiling so ajv doesn't recurse forever.
  New `--negative` flag: generates one additional contract-violation case per operation that has
  something to violate (a request-body property flipped to the wrong JSON type, or a required
  query/header/cookie param omitted — path params are left alone since removing one just breaks
  routing), expecting the declared 4xx (or a generic `4XX` range) rather than acceptance. Tagged
  `type: "Negative"` / technique `error-guessing`, flowing through the same run/report/coverage/ATC
  pipeline as the happy-path cases — a distinct case category, not a parallel one.

- **`cairn api` — Playwright codegen from ATC cases (#144, C1-04 / API-7).** `cairn automate --run
  <runDir>` — the same decoupled design→automate contract web runs use — now also works on an API
  run (`report.json`'s `mode: "api"`, API-4): it reads the ATC `.md` cases (API-5) and generates a
  runnable `tests/api.spec.ts` using `@playwright/test`'s `request` fixture, one `test()` per case,
  asserting the declared success status (exact/`default`/`NXX`, same vocabulary as the runner). No
  LLM call — every field a request needs (method/path/params/body/expected status) is already fully
  structured in the case, so codegen is deterministic templating (the same reasoning as API-2's case
  generation). The generated suite imports nothing from `cairn`, so it runs standalone in CI; `baseURL`
  defaults to the recorded value but is overridable per-environment via `API_BASE_URL`. `--validate`
  is a web-only concept (needs a browser/session) and is a no-op (with a progress note) on an API run.

- **`cairn api` — spec-vs-tested coverage report (#136, C1-04 / API-6, `playswag`-style).** Given the
  ingested spec (API-1) and the generated/executed cases (API-2/API-3), `cairn api` now reports which
  operations are untested and which are only **partially** exercised: an operation is `covered` only
  when every response status it declares (e.g. `200` **and** `404`) has a matching case, `partial`
  when some (but not all) are, and `uncovered` when none are. Since every API-2 case is still a single
  happy-path call, any operation declaring more than one response is `partial` by construction — a
  concrete, honest signal (endpoint coverage ≠ test-pass rate) rather than a percentage that looks
  better than it is. Shown as a summary + gaps-only listing on stdout, in `report.md` (new `## Coverage`
  section), and as `coverage` in `report.json`; works without `--base-url` too (spec-vs-generated-cases).
  Matching is by `operationId`/`METHOD path` (shared with case generation, `apiEndpointKey`), and the
  spec's own `deprecated` flag is surfaced per row rather than filtered out. Feeds BORROW-07 (#95,
  adversarial styles) and L2-05 coverage gap-analysis.

- **`cairn api` — Plune-record write + methodology rigor (#135, C1-04 / API-5).** A `--base-url` run now
  emits every generated case as an **ATC artifact** (`runs/api-<id>/testcases/<id>.md`) — the same
  `testcases/<id>.md` boundary web runs already write, so Plune ingests API cases identically. Each
  case is **methodology-tagged**: an ISO/IEC/IEEE 29119-4 `technique` (currently `equivalence-partitioning`
  — the valid class API-2's happy-path synthesis embodies) plus a per-case coverage **rationale**
  explaining what it exercises and why, both in the case's own frontmatter/fields and surfaced in
  `report.json` (`cases[]`) and the case listing on stdout. Each ATC's `status` is **provenance-checked**
  (aligned with BORROW-04, #91): it only reads "Passed" when a same-named, positively-asserted result
  exists — never inferred from the mere absence of a failure. Cases-only invocations (no `--base-url`)
  are unchanged (print-only, matching API-1..4 precedent) — no run directory exists yet to write into.

- **`cairn api` — reporting + run summary/TUI integration (#134, C1-04 / API-4).** A `--base-url` run
  now writes `report.json` + `report.md` alongside the existing `api-evidence.json`, in the same
  shape/location web runs already use — so the TUI's past-run browser (`Past runs`) lists api runs
  too, showing per-operation pass/fail and endpoint coverage instead of green%/pilot. The CLI's final
  line is now the **shared** `renderRunSummary` footer ("Operations: X/Y passed · N endpoint(s)
  covered", evidence path, artifacts dir) — the same renderer web runs use, not a parallel one.

- **`cairn api` — runner + response assertions (#133, C1-04 / API-3).** With `--base-url <url>`,
  `cairn api` now **executes** the generated happy-path cases (API-2) and, per case, asserts the HTTP
  **status** matches the declared success code and the response **body conforms** to the declared
  success schema (a minimal structural check: type/required/properties/items/enum/nullable +
  `allOf`/`oneOf`/`anyOf`). Auth/headers come from **config** (`--header "Name: Value"`, repeatable)
  layered over **api-scope knowledge** (#92 — `header.*` front-matter in `all`/`api` files, with
  `${ENV}` resolved so the secret stays in the environment, not the file); config wins. Transient
  faults (connection reset / timeout / `429` / `5xx`) **retry with backoff** before failing, reusing
  the tiered-recovery pattern from #90; DNS/refused and `4xx` fail fast. Per-case request/response
  **evidence** (sensitive headers redacted) is written to `runs/api-<id>/api-evidence.json`, and any
  failed assertion exits non-zero. Network is fully injectable (mocked in tests). **The rich report /
  Plune-record write are API-4.**

- **`cairn api` — baseline happy-path cases (#132, C1-04 / API-2).** From the ingested endpoint model,
  `cairn api` now generates **one nominal happy-path case per operation**: required params and a
  request body are synthesised straight from the (dereferenced) JSON schema — respecting
  `example` → `default` → `enum` → type, `required`, `format`, `allOf`/`oneOf`, and circular `$ref`s —
  paired with the operation's declared success response (lowest `2xx`, else `default`). Synthesis is
  **pure and deterministic** (no LLM, so the same spec yields byte-identical cases); the command prints
  the generated cases beneath the model summary. **Still no runner** — execution + assertions are
  API-3 (#138).

- **`cairn api` — OpenAPI ingest (#22, C1-04 / API-1).** The `api` modality leaves the gate one slice
  at a time. This first slice registers `cairn api --spec <path|url>` (parity with `cairn explore`) and
  ingests an **OpenAPI 3.x** spec — JSON or YAML, local file or `http(s)` URL — into an internal
  endpoint model (method, path, params, request/response schemas, `operationId`, security), then prints
  a verifiable summary (*"N endpoints across M tags"* + the endpoint list). `$ref`s (incl. circular)
  and 3.0/3.1 are handled via `@apidevtools/swagger-parser`; a malformed/unsupported spec fails with a
  clear message and a non-zero exit, never a crash. **No case generation yet** — that, the runner and
  the report are API-2 (#137); the Plune-record write + methodological rigor are API-3 (#138).

- **Per-scenario screencast recording — `--screencast` (#94, BORROW-05).** Validation can now record a
  `.webm` per scenario (Playwright's built-in video) into `runs/<id>/screencasts/`, with a
  `screencasts.json` sidecar mapping each scenario's **step chapters** (step title → timecode) — a
  review-gate affordance so a human can *watch* what the agent did before approving. Opt-in
  (`cairn explore --screencast` · `cairn automate --validate --screencast`); off by default, so existing
  runs are unchanged. The `.webm` paths + chapter counts are linked from the run summary and the TUI result
  screen. Recording is best-effort: a recorder/IO failure logs nothing fatal and never sinks the run.

- **Documentarian — cached, reusable page-understanding artifact (#93, BORROW-06).** A run now emits a
  strict-schema **interaction map** (element → locator + container + candidate actions) as a first-class
  artifact (`runs/<id>/page-understanding.json`) and caches it cross-run under `.cairn-cache/understanding`,
  keyed by `url + page fingerprint` (a hash of the ARIA snapshot). A second run on the **same** page reuses
  the cached understanding and **skips the ground (`analyzePage`) LLM call** → fewer observe/ground calls;
  a changed page misses the cache and re-grounds (deliberate invalidation). The map is assembled
  deterministically from existing observe/verify/probe outputs — no extra LLM call is introduced. `--fresh`
  bypasses the cache. Cross-run/per-app semantic memory stays out of scope (that is MEM-02, #64).

- **Scope-aware knowledge injection — `scope: web | api | all` (#92, BORROW-03).** `knowledge/*.md`
  files now declare a scope and are keyed by `url || path || endpoint`. Directory convention:
  `knowledge/` = web (keyed by `url:`), `knowledge/api/` = api (keyed by `path:`/`endpoint:`), and an
  explicit `scope:` front-matter overrides the directory default. A web run injects web+all, an api run
  injects api+all, and a shared `scope: all` file (e.g. credentials) is available to both. Plumbing
  ahead of the API surface (#22) — improves web runs today. Back-compatible: an existing base-dir
  `url:` file with no `scope:` stays web-scoped and behaves exactly as before.

- **Goal-directed exploration — `cairn explore --goal "..."` (#63, MEM-01).** Accept a natural-language
  goal (e.g. `"test the checkout flow"`) and bias the run toward it instead of a blind crawl: the goal
  threads into both observation (`identify-elements` prioritizes goal-relevant elements) and planning
  (the case designer leads with goal-relevant cases). Passed per-run through the existing input path
  (like `--checklist`, nothing hardcoded). Fully back-compatible — without `--goal` the prompts are
  byte-identical and the crawl is unchanged.

- **CI / PR bot — GitHub Action (#50).** A reusable composite action (`action/`) that runs Cairn on a
  pull request, posts (or updates) a **summary comment**, and **optionally opens a follow-up PR** with
  the generated tests. `v1` is generation-on-PR; maintenance/self-heal stays in epic #46. The action is
  a thin wrapper over the shared core via a new `cairn ci` command (same pattern as `cairn mcp`, #49):
  inputs flow in as `INPUT_*` env, provider keys are read from repo secrets (never hardcoded), and
  generated specs land in the host Playwright project through the `--into-project` writer (#51).
  Behavior: the comment is **idempotent** (matched by a hidden marker — re-runs update, never
  duplicate); a `paths` glob gates on the PR's **changed surface** (no match → a no-op comment, no run);
  the follow-up PR is **opt-in** (`open-pr`, `explore` mode only); **fork PRs** (read-only token) skip
  the write effects with a logged reason. Required secrets/permissions are documented in
  [`action/README.md`](action/README.md) for a repo admin to set — the action never configures them.

- **Plug into existing Playwright projects — `--into-project` (#51).** Cairn can now write the
  generated specs straight into a host project's Playwright setup instead of the greenfield
  `runs/<id>/tests` folder. `cairn explore … --into-project [dir]` / `cairn automate … --into-project [dir]`
  (and the `intoProject`/`projectDir` inputs on the public API + MCP `explore`/`automate` tools)
  detect the nearest `playwright.config.{ts,js,mjs,cjs}` (walking up from the cwd, or from an explicit
  `dir`), resolve its `testDir`, and emit specs there using the project's filename convention
  (`.spec.ts` vs `.test.ts`, read best-effort from `testMatch`). Placement is **collision-safe** — a
  pre-existing spec is never overwritten; Cairn disambiguates its own file (`login.cairn.spec.ts`)
  instead. Validation/repair still run against an isolated `runs/<id>/tests` sandbox (same Playwright,
  identical result — so the user's existing suite is never run or deleted); the validated best specs
  are then ejected into the project's `testDir` (single deliverable, discoverable by the project's own
  `npx playwright test`) and the sandbox is removed, while the `runs/<id>/` trail keeps
  study/report/testcases. Without the flag, behavior is unchanged (greenfield `runs/`). When the flag
  is set but no config is found, Cairn logs that and falls back to greenfield (no failure).

- **MCP server — `cairn mcp` (#49).** Cairn's core is now exposed as an
  [MCP](https://modelcontextprotocol.io) server, so other agents (Claude Code, Cursor) can call test
  generation as a tool. `cairn mcp` starts a **stdio** server with three tools — **`explore`** (cases +
  `@playwright/test` code + validate ⇄ repair), **`design`** (cases only), and **`automate`** (code
  from a previous run's ready cases) — thin adapters over the same `runExploration` / `runDesign` /
  `runAutomate` core the CLI uses (config / role routing / cost reused, no new generation logic).
  `explore`/`design` input mirrors the `explore` flags (`url` + optional
  `session`/`flow`/`setup`/`gaps`/`critique`/`fresh`/`checklist`/`style`/`routing`/`backend`/`maxPages`);
  `automate` takes `run` (the run dir) + optional `validate`/`session`. Results return as structured
  JSON (cases or spec files, validation, metrics, the Pilot verdict, cost, run dir).
  `@modelcontextprotocol/sdk` is an **optional dependency** (lazy-loaded only on the `cairn mcp` path,
  like Ink for the TUI). Connect snippet: [docs/mcp.md](docs/mcp.md).

### Changed

### Fixed

- **`cairn api --adversarial hacker` expected the wrong status code on some specs (#154).** The
  auth-header-stripped case (added in #95) reused `pickErrorStatus`'s generic "lowest declared 4xx" —
  right for a schema-violation case, wrong here: an operation can legitimately declare an unrelated
  4xx (e.g. `404 Not found`, or a lexically-lower `400 Bad request`) that has nothing to do with
  authentication. `toHackerCase` now prefers a declared `401`, then `403` — the specific "auth
  rejection" codes — over the generic fallback, which only still applies when neither is declared.
  Found live: a real mock server correctly rejecting an unauthenticated request with `401` was
  failing the case, which expected `404` instead.

- **OpenRouter codegen/reasoning latency — `explore`/`design` no longer hang (#110).** On the
  `openrouter` profile / `volume` routing, `deepseek-chat` (codegen) ran 4.5–13 min and `deepseek-r1`
  (reasoner) overran interactive/MCP timeouts without finishing. Two fixes:
  - **Per-step timeout** (`STEP_TIMEOUT_MS`, default **240000 ms** / 4 min; `0` disables). Each
    structured LLM call is now bounded — a pathologically slow provider fails fast with an **actionable
    error** (suggesting a faster `--routing`/Anthropic, or raising `STEP_TIMEOUT_MS`) instead of hanging
    indefinitely, which the MCP server's caller cannot otherwise observe. Healthy Anthropic steps
    (~90 s) are unaffected.
  - **New `volume-fast` routing preset** (`--routing volume-fast` / `LLM_ROUTING=volume-fast`): codegen
    + analyze (worker) on Anthropic Sonnet — fast where `deepseek-chat` is not — while the cheap
    LLM-as-judge scorer stays on OpenRouter via `LLM_PROFILE`. Unlike `fast` (Groq), it avoids the
    large-codegen `json_schema` 400 (`groq-fast-json-schema-bug`), so it is the recommended escape for
    slow OpenRouter codegen.

## [0.5.0] - 2026-06-24

### Added

- **Provenance-checked Pilot verdicts + data-protection guardrails (#91).** Two cheap safety rules
  (borrowed from Explorbot) that land **before** any stateful / destructive automation. (1) The Pilot's
  holistic `pass` is now **provenance-checked**: the verdict carries the name of the entity the run
  claims to have created/edited, and a `pass` is downgraded to `needs-work` (reason recorded) when that
  entity is **absent** from the run's session log (case titles + steps + observed element names) —
  killing a class of LLM false-positives. (2) A reusable `guardDeletion` policy refuses to delete
  **pre-existing** data or the resource under the **current URL**; only self-created items are
  disposable. The setup planner gains `enforceDataProtection`, which forces any delete/clear
  precondition to the **manual** fallback (at setup time nothing is self-created yet, so such a deletion
  would hit pre-existing data). Pure helpers in `src/safety/guardrails.ts`; the Tester side stays
  read-only by existing prompt policy.

- **Coverage gap-analysis (#61).** After design, every run now emits a **coverage view** — the observed
  interactive surface (elements per page + flow transitions, #59) **minus** what any case or journey
  references (by `elementRefs` + journey steps). `report.json` gains a `coverage` block and `report.md`
  a **Coverage** section: covered vs observed-but-untested, grouped by page, each gap with a short
  "why it matters", plus any untested transitions. With **`--gaps`**, Cairn additionally suggests cases
  for the top untested elements (worker tier), grounded to the gap refs and clearly marked as
  SUGGESTIONS (a `gap-` id prefix). The coverage view is read-only and additive (it changes no generated
  test artifact); `--gaps` is opt-in and bounded (top-N gaps) to keep cost predictable.

- **Journey state & data setup — `--setup` (#60).** Multi-page journeys (#59) often need a
  starting state beyond auth (a logged-in user *with* specific data). With `--setup`, Cairn turns each
  journey's prose preconditions into **structured** ones (worker tier, `CAIRN_ROLE_WORKER`) and assigns
  a satisfaction **strategy** in priority order: reuse the captured **session** → a Playwright
  **fixture** (`beforeEach`) → an **API seed** when a concrete endpoint is named → a documented
  **manual** fallback. It emits a runnable `@playwright/test` spec per journey under `runs/<id>/journeys/`,
  with the setup established **before** the steps; steps stay read-only (`toBeVisible`) and refs are
  resolved per page. Safety: an `api-seed` without a concrete endpoint is **downgraded to manual** —
  Cairn never fabricates (possibly destructive) seeding. Opt-in; absent `--setup`, nothing changes.
  The setup plans are recorded in `report.json` (`flow.setup`).

- **Multi-page / flow exploration — `--flow` / `--max-pages N` (#59).** Opt-in, Cairn now follows
  in-app navigation from the start page to build a **page/flow graph** (nodes = studied pages, edges =
  observed transitions), reusing the captured `--session` storageState across pages, and designs
  **multi-page USER JOURNEY cases** (ordered steps that cross page boundaries) in **addition** to the
  per-page cases. The crawl is pure browser mechanics (no LLM), bounded by `--max-pages` (default 3),
  stays in-origin, dedupes revisits, and **never follows destructive links** (log out / delete) — so
  the session and read-only safety hold across the whole walk. Journey steps are grounded **per page**
  (a step only references elements that exist on its own page), and only journeys spanning ≥2 distinct
  pages are kept. The graph + journeys are persisted in `report.json` (`flow`) and rendered in
  `report.md`. Without `--flow`, single-page behavior is byte-for-byte unchanged. The design
  methodology / assertion-safety rules are untouched.

- **First-class prompt overrides + house-style packs (#80).** A committed `prompts/` scaffold now
  ships in the repo: a `prompts/README.md` documenting the override precedence (Langfuse →
  `prompts/<name>.md` → built-in constant) and `prompts/qa-testcase-from-ui.md` — the built-in design
  prompt **verbatim** — so you can see exactly what is overridable (a drift guard keeps it in sync).
  `--style <value>` is promoted to a dual resolver: a **style pack** (`prompts/styles/<value>.md` or an
  explicit `.md` path) is loaded into the prompt's `{{style}}` slot, otherwise it falls back to the
  existing inline hint (`happy` / `negative` / `coverage`). Three built-in packs ship —
  `concise`, `gherkin`, `detailed-manual`. Style affects **only** naming / format / language / tone;
  it never changes technique coverage or assertion safety (the methodology stays fixed). Back-compat:
  the short `--style happy|negative|coverage|all` behavior is unchanged.

- **`--critique` flag on `cairn design` and `cairn explore` (#82)** — an opt-in design-time
  self-critique pass that runs once AFTER the first design set and BEFORE finalization. On the cheap
  **worker** role (`CAIRN_ROLE_WORKER`) it (a) prunes trivial / contradictory / unverifiable cases and
  (b) tops up techniques under-represented across the 6 × ISO/IEC/IEEE 29119-4 set — feeding quality
  signal back into generation instead of only scoring it post-hoc. The prune/top-up delta (cases
  pruned, techniques added, technique-coverage before→after) is recorded in `report.json` under
  `critique`, next to the existing `technique_coverage` / `case_redundancy` metrics. Bounded to a
  **single** worker-tier LLM call; conservative default (**off** unless `--critique` is passed). The
  methodology and assertion-safety rules are unchanged — the pass only prunes and fills gaps, and
  top-up refs are grounded against real elements like the main design step. Behavior is identical to
  before when the flag is absent.

- **`--fresh` flag on `cairn design` and `cairn explore`** (and a matching TUI toggle) — ignore
  prior-run experience for a URL. By default a 2nd+ run on the same URL reuses its *previously stable*
  cases as design-prompt context and generates only the **delta** (new cases); `--fresh` skips that
  disk read entirely (`collectPriorRuns`) and generates a **full set** every time, for clean A/B
  comparisons. The gate is shared by both flows via `experienceForUrl()` in `src/eval/collect.ts`.
  Behavior is unchanged when the flag is absent — no generated artifact differs. (See ADR-0006.)
- **Inline metric legend.** `report.md`'s Metrics table now carries a `meaning` column and a ↑/↓
  direction per metric (plus a one-line key explaining the glyphs and the `judge` tag); the console
  `=== Metrics ===` output appends the same ↑/↓ glyph so `case_redundancy` / `flaky_ratio` (lower is
  better) can't be misread. A new README **Metrics** section documents every metric. All three render
  from one source of truth — `METRIC_LEGEND` in `src/eval/legend.ts` — so they can't drift. No metric
  value or name changed.

### Changed

- **Slimmed the README into a ~30-second shop window (#81).** The README is now ≤ ~150 lines in a
  what/why → install → quickstart → command table → doc-links order; the reference material moved into
  dedicated, linked pages under `docs/`: `sessions.md` (authenticated targets), `configuration.md`
  (env + role routing), `prompts-and-styles.md` (NEW — methodology vs style, override precedence,
  `--style` packs), `tui.md`, `metrics.md`, `cost.md`, `langfuse.md`. The `BENCHMARK` markers moved
  with the cost section, so `npm run bench` now rewrites `docs/cost.md` (was `README.md`), and the
  `KEEP IN SYNC` note for the metric legend now points at `docs/metrics.md`. No code behavior changed.

### Fixed

- **Flow runs persist per-page crawl snapshots (#103).** A multi-page `--flow` run left only the start
  page's `snapshots/aria.yaml` + `screenshot.png`, even though the crawl studied every page — each
  `FlowNode.study` held a full aria/screenshot that was then discarded. Each crawled node now gets its
  own `snapshots/<index>-<slug>/aria.yaml` + `screenshot.png` (index-prefixed → collision-safe), and
  `report.json`'s `flow.pages[]` carries a per-page `snapshot` reference so the page graph is
  inspectable. The start page's root `snapshots/` files are unchanged (single-page runs unaffected).

- **Flow crawl now follows links on client-routed SPAs (#102).** `explore --flow` built a 1-node graph
  on SPA front-ends (e.g. Next.js): after a link click the router updates `location.href` asynchronously,
  but `observe` returned the cached `currentUrl` (only refreshed on an explicit navigation), so every
  crawled URL collapsed back to the start → 0 cross-page journeys → the setup planner never ran. The
  crawl now (a) waits for the URL to change after a click (`ObserveOptions.waitForUrlChange`, polled
  best-effort in the lib backend) and reads the **live** `page.url()` when not navigating explicitly,
  and (b) dedups links by `(name, href)` so a repeated link name (e.g. 3× "See the platform") isn't
  followed multiple times. Link hrefs are captured from the ARIA `/url` property. Server-side navigation
  (click → new URL + full load) is unchanged.

- **`explore` no longer crashes with EBUSY on Windows during repair (#101).** The artifact writer
  fully overwrites `tests/` on every generation (`writeSuite`), but on Windows the Playwright runner
  from the just-finished validation can still hold a handle there — so the recursive `rm` threw
  `EBUSY`/`EPERM` and the whole run rejected on the first repair attempt. Cleanup now goes through a
  resilient `rmrf` helper that retries the recursive remove with exponential backoff on transient lock
  codes (`EBUSY`/`EPERM`/`ENOTEMPTY`) and, if the lock never clears, gives up cleanly (best-effort)
  instead of sinking the run. POSIX behaviour is unchanged (the first attempt always wins) and non-lock
  errors still propagate immediately. The same guard is applied to `writeJourneySpecs`.

- **Provider-safe strict JSON schemas for all structured LLM invokes (#89).** Strict structured-output
  providers (Groq `fast`, OpenRouter `volume`, Anthropic tool-calling) require **every** property to be
  in `required`; an `.optional()` key is dropped from `required` and causes intermittent cross-provider
  schema-parse failures. The lone offending schema — `StructuredPreconditionSchema`'s
  `entity`/`endpoint`/`method` — moves from `.optional()` to `.nullable().default(null)`: kept in
  `required` (provider-safe) yet tolerant of a provider that omits the key (parses to `null`). A new
  **schema-lint** (`src/llm/schema-lint.ts`, over zod 4's native `z.toJSONSchema`) asserts
  `required == properties` across all 9 structured-invoke schemas, with a drift guard that fails the
  build if a new `invoke(...Schema)` isn't covered. Validated live on both `volume` (OpenRouter) and
  `fast` (Groq); a companion `qa-setup-planner` prompt tweak makes the weaker Groq model always emit the
  nullable keys as `null` (strict tool-call validation rejects an omitted required key).

- **Tiered transient-error recovery in BrowserGateway (#90).** A transient SPA navigation error (an
  in-app redirect aborting the in-flight `goto`, a network blip, a load-state timeout) previously killed
  the step — `observe()` did a bare `page.goto` with no handling. Navigation now runs through a
  classification ladder (`src/browser/recovery.ts`): a **transient** error gets a cheap settle + retry on
  the **same** page — grounded state (the ref→locator map) is preserved — and only a **fatal** /
  retry-exhausted error escalates to the expensive recovery (recreate the page on the same context; auth
  survives, grounding is rebuilt). Unknown errors default to `fatal`, so real bugs aren't masked by
  silent retries. lib backend (PRIMARY); the CLI backend is out of scope.

- **Robust `--run` / `--from-run` path resolution on Windows / Git-Bash (#79).** In Git Bash an
  unquoted backslash is a shell escape, so `--run runs\<id>` reached the process as the glued `runs<id>`
  (the separator eaten before Node ran) → `ENOENT` on the testcases path. A new `src/fs/run-dir.ts`
  resolves `runs/<id>`, an absolute path, a bare `<id>`, and recovers the glued case; otherwise it
  throws an actionable error listing available runs plus a bare-id / Git-Bash tip. `readInputFile` gives
  a friendly `ENOENT` (+ Git-Bash tip) for file flags (`--checklist` / `--dataset` / `--candidate`), and
  `defaultRunsBaseDir()` becomes the single source for the runs base dir (was duplicated 5×).

[0.5.0]: https://github.com/plune-ai/cairn/compare/v0.4.0...v0.5.0

## [0.4.0] - 2026-06-19

### Changed

- **Drop `@langchain/langgraph` — plain async pipeline (ADR-0013).** The LangGraph
  `StateGraph` / `Annotation.Root` orchestrator is replaced by `runExploreGraph(deps, init):
  Promise<ExploreOutcome>` — a plain async function with sequential `await` calls for each
  stage. The stage seams (`BrowserGateway`, `StructuredInvoke`) and all domain node bodies are
  untouched. The generate⇄validate⇄repair portion now delegates to the existing `runRepairLoop`
  helper (removing the inline keep-best duplicate). `@langchain/core` (provider-agnostic LLM
  factory) is retained; only the graph orchestration layer is removed.
- **Telemetry rebound at the LLM layer.** Each run is wrapped in a lazy Langfuse root span
  (`startActiveObservation` from `@langfuse/tracing`); `RoleRouter` threads the
  `@langfuse/langchain` `CallbackHandler` into every LLM call config — preserving the full
  nested trace structure (one root span, one nested generation per stage LLM call) without
  LangGraph as the propagation vehicle. `last_trace_id` is returned in `ExploreOutcome`.
- **Ink / React are now optional.** The TUI packages (`ink`, `react`, `ink-select-input`,
  `ink-text-input`, `ink-spinner`) moved from `dependencies` to `optionalDependencies`. A
  default `npm install @plune-ai/cairn` no longer pulls them — install them manually to enable
  the interactive TUI (`npm i ink react ink-select-input ink-spinner ink-text-input`). If the
  packages are absent, `cairn` with no arguments falls back gracefully to printing help.

### Removed

- **`@langchain/langgraph`** from `dependencies` and the codebase (no import anywhere — grep clean).
- **`scripts/spike-s5-langfuse.ts`** and its npm script (`spike:s5-langfuse`) — the S5 spike is
  closed and its langgraph import is no longer valid.

> **Backward compatibility:** the public API (`runExploration`, `runDesign`, `runAutomate`,
> `loadConfig`), all `explore` / `design` / `automate` / `observe` CLI commands, existing
> configs, sessions, and run artifacts are unchanged. Telemetry and the TUI are opt-in — install
> their optional packages to use them. Tests: 416 green (vitest), coverage gate passes.

[0.4.0]: https://github.com/plune-ai/cairn/compare/v0.3.4...v0.4.0

## [0.3.4] - 2026-06-18

### Fixed

- **Interactive TUI: promote more than one manual case per review session.** In the run-detail review
  (`cairn` TUI → open a run → Cases tab), pressing `a` to promote a manual case (MTC → ATC) worked only
  ONCE per mount — every later `a` was swallowed until you exited the review and re-entered. Two causes:
  a one-shot `promoted` flag set on the first promote and never reset, and the `useInput` handler closing
  over a stale case snapshot between rapid keypresses. The handler now reads the current case + selection
  through refs (never a mount snapshot), the in-flight guard resets on completion, the case list reloads
  and re-sorts after each promote, and the selection is clamped to stay in range. You can now promote
  MTC #1, navigate to MTC #2, press `a`, and it promotes too — no exit/re-enter. Promoting an
  already-ATC case is a safe no-op.

[0.3.4]: https://github.com/plune-ai/cairn/compare/v0.3.3...v0.3.4

## [0.3.3] - 2026-06-18

### Fixed

- **Works inside projects that already have Playwright.** Cairn no longer pulls a second, *alpha*
  `playwright-core`: the experimental `cli` backend's `@playwright/cli` is now an optional peer, so a
  default install resolves a **single stable `playwright-core`** — the same build Cairn launches at
  runtime and the same one its installer targets. Previously the alpha needed a Chromium revision a
  normal `playwright install` never provided, so Cairn reported *"Playwright browsers are not
  installed"* even after following the suggested command.
- **The browser preflight no longer blocks the channel / reuse paths.** `explore` and
  `automate --validate` now pass the configured browser channel to the preflight, so `--channel chrome`
  / `BROWSER_CHANNEL=chrome` drives your installed Google Chrome with **zero download**, and an
  already-installed compatible Chromium is reused instead of demanding a re-install. The generated
  `@playwright/test` config carries the channel end-to-end.
- **Accurate browser diagnostics.** The "browsers not installed" message now prints Cairn's own
  Playwright version, the exact Chromium it expects, and the two real fixes — never the generic
  `npx playwright install` hint, which resolved to the *wrong* Playwright and so never helped.

### Added

- `cairn install-browsers` — downloads the Chromium build Cairn drives using **Cairn's own** Playwright,
  so the revision always matches what Cairn launches (regardless of any other Playwright in the project).
- `cairn doctor` — diagnoses the browser setup (Playwright version, expected Chromium, how to fix).
- `--channel <chrome|msedge>` on `explore`, `design`, `automate`, and `observe` (maps to
  `BROWSER_CHANNEL`) — drive a system browser with no bundled-Chromium download.

### Changed

- **Langfuse / OpenTelemetry are now optional.** `@langfuse/*` and `@opentelemetry/*` moved out of the
  default dependencies (to optional peers); telemetry lazy-loads them only when Langfuse is configured
  and silently no-ops when they're absent. This removes the only `npm audit` moderate
  (`@opentelemetry/core <2.8.0`) from a default install and roughly **two-thirds** of the footprint
  (clean-dir prod packages: **265 → 87**). To enable tracing, install the packages listed in the README.

> **Backward compatibility:** the default `lib` browser backend, the public API, and existing configs
> are unchanged. Tracing and the experimental `cli` backend are opt-in — install their (now optional)
> packages to use them.

[0.3.3]: https://github.com/plune-ai/cairn/compare/v0.3.2...v0.3.3

## [0.3.0] - 2026-06-14

### Added

- Per-role model routing (`worker`/`reasoner`) with `LLM_ROUTING` presets `volume` (OpenRouter) and `fast` (Groq), plus `CAIRN_ROLE_*` overrides; per-run, per-role cost & token reporting in `report.md` / `report.json` / the CLI. (#6, #7)
- Groq provider. (#7)
- Reproducible cost benchmark via `npm run bench`. (#8)
- First-class session management — `cairn session capture | ls | rm` (and the `cairn login` alias) — with missing/expired-session UX. (#27)

### Changed

- License: relicensed from GPL-3.0-only to Apache-2.0 (permissive; patent grant). See ADR-0012.
- `cairn explore` hardening: graceful browser/observe error handling, repair-loop no-progress convergence, `CallBudget` usage surfaced in the output, and a clearer first-run summary. (#26)
- Pilot verdict now runs on the strong `reasoner` role (was the cheap `judge` tier). (#6)
- The decoupled `design → automate` flow now runs the same validate⇄repair⇄keep-best loop as `explore`, and `explore` now also emits ATC/MTC case files to `testcases/`. (#39, #40)

> **Backward compatibility:** `LLM_PROFILE` and existing configs are unchanged — per-role routing, cost reporting, and the new session commands are additive and opt-in.

[0.3.0]: https://github.com/plune-ai/cairn/compare/v0.2.1...v0.3.0
