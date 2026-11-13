import { describe, expect, it } from "vitest";
import {
  MAILBOX_FIXTURE,
  MAILBOX_FIXTURE_FILE,
  mailboxPromptSection,
  renderMailboxSteps,
  withMailboxFixture,
} from "../../src/codegen/mailbox.js";
import { mailboxNeed } from "../../src/mailbox/rule.js";
import { FakeMailbox, MailboxSession } from "../../src/mailbox/index.js";

const KEY = "mk-NOT-REAL-4f9a2c";
const TOTP = "JBSWY3DPEHPK3PXP";
const env = { MAILSAC_API_KEY: KEY, APP_TOTP: TOTP };

describe("mailbox/TOTP steps → @playwright/test code", () => {
  it("the emitted steps and fixture hold variable NAMES, never a value", async () => {
    const mail = new MailboxSession({ provider: new FakeMailbox(), runId: "r1", env, totpSecretEnv: "APP_TOTP" });
    await mail.run({ action: "mailbox.create" });
    await mail.run({ action: "totp.code", secretEnv: "APP_TOTP" });
    const totp = mailboxNeed({ fields: [{ role: "textbox", name: "Authentication code" }], text: "", steps: [] }, { enabled: true, totpSecretEnv: mail.totpSecretEnv })!;
    const link = mailboxNeed({ fields: [], text: "Check your email", steps: [] }, { enabled: true })!;
    const code = [renderMailboxSteps(totp.steps!), mailboxPromptSection(link), MAILBOX_FIXTURE].join("\n");

    expect(code).toContain(`await mail.run({"action":"totp.code","secretEnv":"APP_TOTP"});`);
    expect(code).toContain("await page.goto(mail.resolve('{{mailbox.link}}'));");
    expect(code).toContain("mailsacFromEnv()");
    expect(mail.codeSecrets).toEqual(expect.arrayContaining([KEY, TOTP]));
    expect(mail.codeSecrets.length).toBeGreaterThan(3); // the address and the code are in too
    for (const secret of mail.codeSecrets) expect(code).not.toContain(secret);
  });

  it("refuses a TOTP secret written where its variable's name belongs", () => {
    expect(() => renderMailboxSteps([{ action: "totp.code", secretEnv: "JBSW Y3DP EHPK 3PXP" }])).toThrow(/NAME of an environment variable/);
  });

  it("adds the fixture module, replacing a model-written one", () => {
    const suite = withMailboxFixture(
      { files: [{ path: "a.spec.ts", content: "import { test } from './mailbox.fixture';" }, { path: MAILBOX_FIXTURE_FILE, content: "made up" }] },
      [KEY],
    );
    expect(suite.files.map((f) => f.path)).toEqual(["a.spec.ts", MAILBOX_FIXTURE_FILE]);
    expect(suite.files[1]!.content).toBe(MAILBOX_FIXTURE);
  });

  it("a generated spec that holds a secret value is never written", () => {
    const leaky = { files: [{ path: "a.spec.ts", content: `await page.getByLabel('Code').fill('${TOTP}');` }] };
    let err: Error | undefined;
    try {
      withMailboxFixture(leaky, [KEY, TOTP]);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/a\.spec\.ts contains a mailbox\/TOTP secret value/);
    expect(err?.message).not.toContain(TOTP);
  });
});
