import type { MailboxStep } from "../mailbox/session.js";
import type { MailboxNeed } from "../mailbox/rule.js";
import type { GeneratedSuite } from "./schema.js";

/** The fixture module the specs import when a page needs e-mail or TOTP (ADR-0023). */
export const MAILBOX_FIXTURE_FILE = "mailbox.fixture.ts";

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The `mail` fixture: a `MailboxSession` per test, cleaned up after it (also when it fails). Mailsac is built from the
 * environment on first use, so a TOTP-only test needs no MAILSAC_API_KEY. Nothing in it is a value.
 */
export const MAILBOX_FIXTURE = `// Playwright fixture for the test mailbox and TOTP (cairn, ADR-0023). Written by cairn.
// Read from the environment when a test runs, by name: MAILSAC_API_KEY (MAILSAC_ADDRESS, MAILSAC_DOMAIN optional)
// and the TOTP secret variable a step names. No value is stored here.
import { test as base, expect } from '@playwright/test';
import { MailboxSession, mailsacFromEnv, type MailboxProvider } from '@plune-ai/cairn';

let mailsac: MailboxProvider | undefined;
const provider = (): MailboxProvider => (mailsac ??= mailsacFromEnv());
const lazy: MailboxProvider = {
  name: 'mailsac',
  createAddress: (runId) => provider().createAddress(runId),
  list: (address) => provider().list(address),
  cleanup: (address) => provider().cleanup(address),
};

export const test = base.extend<{ mail: MailboxSession }>({
  // eslint-disable-next-line no-empty-pattern
  mail: async ({}, use, testInfo) => {
    const mail = new MailboxSession({ provider: lazy, runId: testInfo.testId });
    try {
      await use(mail);
    } finally {
      await mail.cleanup();
    }
  },
});

export { expect };
`;

/** One step as test code. Values never appear: only filters and the TOTP variable's NAME; `resolve` reads them late. */
function renderStep(step: MailboxStep): string {
  if (step.action === "totp.code" && !VAR_NAME.test(step.secretEnv)) {
    throw new Error("codegen: totp.code secretEnv must be the NAME of an environment variable, not a value");
  }
  switch (step.action) {
    case "mailbox.openLink":
      return "await page.goto(mail.resolve('{{mailbox.link}}'));";
    case "mailbox.create":
      return `await mail.run(${JSON.stringify(step)}); // then fill the e-mail field with mail.resolve('{{mailbox.address}}')`;
    case "mailbox.extractCode":
      return `await mail.run(${JSON.stringify(step)}); // then fill the code field with mail.resolve('{{mailbox.code}}')`;
    case "totp.code":
      return `await mail.run(${JSON.stringify(step)}); // then fill the code field with mail.resolve('{{totp.code}}')`;
    default:
      return `await mail.run(${JSON.stringify(step)});`;
  }
}

export function renderMailboxSteps(steps: readonly MailboxStep[]): string {
  return steps.map(renderStep).join("\n");
}

/** What codegen is told when the rule fired and the steps are on: use the fixture, emit these steps, no literals. */
export function mailboxPromptSection(need: MailboxNeed): string {
  return [
    `E-MAIL / TOTP: ${need.reason}. Import { test, expect } from './${MAILBOX_FIXTURE_FILE.replace(/\.ts$/, "")}' (not from '@playwright/test') and take the \`mail\` fixture.`,
    `Emit these steps where the flow needs them${need.signal === "totp" ? "" : " (create the address before the e-mail field is filled)"}:`,
    renderMailboxSteps(need.steps ?? []),
    "Never write an address, link, code or secret as a literal: read each one through mail.resolve('{{...}}') only.",
  ].join("\n");
}

/**
 * The suite with the fixture module in it (in place of any file of that name the model wrote). A file that holds a
 * value from `secrets` (the session's addresses, links and codes, the key, the TOTP secret) is never written.
 */
export function withMailboxFixture(suite: GeneratedSuite, secrets: readonly string[]): GeneratedSuite {
  const files = [...suite.files.filter((f) => f.path !== MAILBOX_FIXTURE_FILE), { path: MAILBOX_FIXTURE_FILE, content: MAILBOX_FIXTURE }];
  const leak = files.find((f) => secrets.some((s) => s.length >= 4 && f.content.includes(s)));
  if (leak) throw new Error(`codegen: ${leak.path} contains a mailbox/TOTP secret value; nothing was written`);
  return { files };
}
