/**
 * #230 — the API flows section, appended to the design and codegen prompts only when `--flows <file>` is given (a run
 * without it sends the same prompt as before). Saved API flows set up a case's data or sign-in, so the UI test does
 * not click through them.
 */
export const QA_API_FLOWS_DESIGN = `API flows — saved API requests that set up a test's starting state:
{{flows}}

When a case's precondition is data that one of these flows creates, or a signed-in user that the sign-in flow provides, write that precondition as "API flow <name>: <what it gives>" (e.g. "API flow project: a project exists (projectId)") and do NOT add steps that create that data or sign in through the UI. Do not add steps that delete what a flow created: its cleanup does that after the test. A precondition no flow provides is written as before.`;

export const QA_API_FLOWS_CODEGEN = `API flows: the tests folder has {{fixtureFile}}, a Playwright fixture module with one fixture per flow:
{{flows}}

For a case whose preconditions name an API flow, or need data or a signed-in user that a flow above provides:
- in its spec file, import { test, expect } from './{{fixtureModule}}'; instead of from '@playwright/test', and keep that spec file at the top of the tests folder;
- take the flow's fixture as a test argument and use its values, e.g. test('opens the project', async ({ page, project }) => { await page.goto('{{baseUrl}}/projects/' + project.projectId); ... });
- do NOT create that data or sign in through the UI, and do NOT delete it in the test: the fixture's cleanup runs after the test, also when it fails;
- a sign-in flow sets the session (storageState) of every test that imports the module: do not sign in through the UI.
Do not write {{fixtureFile}} yourself; Cairn writes it.`;
