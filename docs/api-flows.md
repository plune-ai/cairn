# API flows: UI test setup and cleanup through the API (#230)

An **API flow** is a saved chain of requests with a name: its steps, the values it returns (for example
`projectId`), and a cleanup that deletes what it created. Cairn turns a flow file into a Playwright fixture module,
so a UI test gets its data, or its signed-in session, through the API instead of clicking through the
preconditions, and the data is deleted after the test, whether the test passed or failed.

```ts
import { test, expect } from './api-flows.fixture';

test('a project opens', async ({ page, project }) => {
  await page.goto(`/projects/${project.projectId}`);
  await expect(page.getByRole('heading', { name: project.projectName })).toBeVisible();
}); // after the test, project's cleanup deletes it
```

## Get a flow file

- **From the scenario chains** of `cairn api --scenarios` (API-9):
  ```
  cairn api --spec ./openapi.yaml --scenarios --save-flows flows.json
  ```
  Each chain that has a `DELETE` becomes a flow named after its resource (`/pets` → `pets`): the chain's create step,
  the values its `DELETE` needs captured from the create's answer (a declared OpenAPI `links` expression first, a
  field of the same name second, as the scenario runner does), and the `DELETE` as the cleanup. A chain without a
  `DELETE` is not saved (`⊘ … not saved — no DELETE step to clean up what it creates`). Flows already in the file are
  kept; a flow with the same name is replaced. A file that is there but is not a valid flow file is not overwritten.
  Saving sends no request. The saved steps carry the spec's synthesised values: edit them to what your application
  needs.
- **By hand**, in the format below. A sign-in flow is always written by hand.

## The flow file

JSON, `version: 1`:

```json
{
  "version": 1,
  "baseUrl": "https://staging.example.com",
  "headers": { "Authorization": "Bearer {{env.API_TOKEN}}" },
  "flows": [
    {
      "name": "project",
      "description": "a project to open in the UI",
      "steps": [
        {
          "name": "create project",
          "method": "POST",
          "path": "/api/projects",
          "body": { "name": "Project {{uid}}" },
          "expect": 201,
          "capture": { "projectId": "/id", "projectName": "$response.body#/name" }
        }
      ],
      "returns": ["projectId", "projectName"],
      "cleanup": [
        { "name": "delete project", "method": "DELETE", "path": "/api/projects/{{projectId}}", "expect": [204, 404] }
      ]
    },
    {
      "name": "signedIn",
      "kind": "signin",
      "steps": [
        { "method": "POST", "path": "/api/login", "form": { "user": "{{env.APP_USER}}", "password": "{{env.APP_PASSWORD}}" } }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `baseUrl` | Optional. Where the API lives. |
| `headers` | Optional. Headers on every request; they may use `{{env.NAME}}` and `{{uid}}` only. |
| `flows[].name` | The fixture's name in the tests: a TypeScript identifier, not one Playwright already uses (`page`, `request`, `storageState`, …), and not one that differs from another flow's only in its first letter's case (`a` and `A` would both be `type AFlow`). |
| `flows[].kind` | `data` (default) or `signin`. At most one sign-in flow per file; it sends at most one request that changes data (the login itself), its other steps are `GET`/`HEAD`/`OPTIONS`. |
| `flows[].description` | Optional. Shown to `design` and `automate`. |
| `flows[].steps` | The requests, in order (at least one). |
| `flows[].returns` | The captured values the fixture gives the test, as `{ name: string }`. A sign-in flow returns nothing. |
| `flows[].cleanup` | The requests that delete what the flow created. **Required** for a data flow that changes data. A sign-in flow has none. |

A step: `method` (`GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`, `DELETE`), `path` (starts with one `/`, has no `?` — query
parameters go in `query`; it is appended to the base URL, so a base path such as `/v1` is kept), and optionally `name`, `headers`, `query`, `body`
(sent as JSON) or `form` (sent URL-encoded; not both), `expect` (a status or a list; default any 2xx or 3xx; redirects
are not followed) and `capture` (name → JSON pointer into the JSON answer, `/id` or `$response.body#/id`).

Templates, in a step's `path`, `headers`, `query`, `body` and `form` (a `name` is only a label, and is not filled): `{{name}}` — a value captured by an earlier step (in the cleanup, any step);
`{{env.NAME}}` — read from the environment when the test runs; `{{uid}}` — a value unique to this fixture run, for
names that must not collide. In a path, values are URL-encoded, and a value that is empty, `.`, `..` or holds a `/`
is refused rather than sent. A captured value that is empty counts as not captured. A template that names nothing known is refused when
the file is read.

**No secrets in the file.** A header such as `Authorization`, `Cookie` or `X-Api-Key`, and a body, form or query
field such as `password`, `pass`, `pwd`, `credentials`, `api_key`, `access_token`, `token`, `secret` or `auth`, at any
depth, must be written as `{{env.NAME}}`, optionally after `Bearer `, `Basic ` or `Token `; anything else in the value
is refused. Values read from
the environment are never written into the fixture module.

## Write the fixture

```
cairn api --flows flows.json --out e2e/fixtures
```

writes `e2e/fixtures/api-flows.fixture.ts` and sends no request. The module needs nothing but `@playwright/test`. It
exports `test` (Playwright's, extended with one fixture per data flow) and `expect`. Each data fixture is
test-scoped: it runs its steps in a request context of its own, hands the returned values to the test, and runs the
cleanup in a `finally`, after the test ends, also when the test failed. A cleanup step that needs a value that was
never captured (the create itself failed, or answered an empty id), or one that cannot stand in its path, is
left out; a cleanup step that fails fails the test, naming the step,
since the data may still be there. The sign-in flow, when there is one, replaces the tests' `storageState`: it runs
its steps in a fresh request context and gives the cookies the answers set to the browser. An application that keeps
its session in `localStorage` or sends a token header instead of a cookie is not signed in this way; give the data
flows `headers` with `{{env.API_TOKEN}}` there instead. The data fixtures send the tests' `storageState` too, so a
session from the sign-in flow or from `use.storageState` in the config reaches the API as well.

The API address, in this order: `API_BASE_URL` in the environment, `--base-url` (written into the module), the
file's `baseUrl`, then `use.baseURL` from the Playwright config.

The fixture's errors hold no value from the environment or from an answer: they name the step and the template as the
file wrote it (`{{env.SEG}} is a value, which cannot stand in the path /api/{{env.SEG}}`), and a request that got no
answer says only why (`got no answer: ECONNREFUSED`, a timeout, or a network error). That also leaves out Playwright's
call log, which holds the full URL and every header; to see it, run the tests with `DEBUG=pw:api`. A trace, if your
Playwright config records one, does keep every request's headers.

That covers the fixture's own requests. A request the test sends itself still fails with Playwright's call log, and
Playwright writes that log to disk whole, `Authorization` and `set-cookie` included:
`test-results/<test>/error-context.md`, beside the nearest `package.json` (with `--screencast`, under
`runs/<id>/screencasts/`, beside the video). Keep that folder out of anything you publish, such as a CI artifact.

## Flows that change data need an explicit flag

The same read-only default as `cairn api --base-url` (#196): a data flow with a `POST`, `PUT`, `PATCH` or `DELETE`
step runs only against an address that was explicitly allowed. Otherwise the test that asks for it is **skipped**
(not failed), with the reason, and no request is sent:

- `cairn api --flows flows.json --base-url https://staging.example.com --allow-mutations` writes that origin into the
  module as allowed. Without `--allow-mutations`, or without `--base-url`, no address is allowed.
- `CAIRN_ALLOW_MUTATIONS=https://staging.example.com` (comma-separated origins) allows an address when the tests run.

A `GET`-only flow and a sign-in flow do not change data and are not gated: a sign-in flow's one changing request is
the login, and a sign-in flow with a second one is refused when the file is read (and by the fixture). As with `--allow-mutations` everywhere,
point it only at an environment you own, never at production.

## `design` and `automate` use the flows

```
cairn design   --url https://app.example.com/projects --session myapp --flows flows.json
cairn automate --run runs/<id> --flows flows.json [--allow-mutations] [--validate --session myapp]
```

- `design --flows`: the designer sees the flows and writes a precondition that a flow provides as
  `API flow <name>: <what it gives>`, with no UI steps to create that data or to sign in, and no steps that delete it.
- `automate --flows`: each case's preconditions go to the codegen with the flows; a spec whose case uses a flow
  imports `test` and `expect` from `./api-flows.fixture` and takes the flow's fixture as an argument. Cairn writes
  `api-flows.fixture.ts` beside the specs (`runs/<id>/tests/`, or the project's `testDir` with `--into-project`),
  replacing any file of that name the model wrote. The API address written into it is the file's `baseUrl`, else the
  origin of the run's URL; `--allow-mutations` allows that address for flows that change data. Without it, the specs
  that use such a flow are skipped during `--validate`. `--flows` does nothing on an API run. During `--validate`, the
  value of every `{{env.NAME}}` the file names is masked in the failure texts (the repair hint, the triage, the report)
  and the progress lines, raw and URL-encoded, if it has four characters or more and is not a word as common as `true`;
  and a run with flows keeps no trace beside its `--screencast` video.

Without `--flows`, `design` and `automate` send the same prompts as before.
