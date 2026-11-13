import { describe, expect, it } from "vitest";
import { mailboxNeed, type MailboxEvidence } from "../../src/mailbox/rule.js";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";

/** A page as the agent sees it: its ARIA snapshot gives both the fields and the text. */
const page = (aria: string, steps: string[] = []): MailboxEvidence => ({ fields: parseAriaSnapshot(aria), text: aria, steps });

const CHECK_EMAIL = `- heading "Check your email" [level=1]
- paragraph: We've sent a confirmation link to your address. Open it to finish signing up.
- button "Resend"`;

const EMAILED_CODE = `- heading "Verify your email" [level=1]
- paragraph: We sent you a 6-digit code.
- textbox "Verification code"
- button "Continue"`;

const TOTP_PROMPT = `- heading "Two-factor authentication" [level=1]
- paragraph: Enter the code from your authenticator app.
- textbox "Authentication code"
- button "Verify"`;

const CHECKOUT = `- heading "Checkout" [level=1]
- textbox "Email"
- textbox "Postal code"
- textbox "Promo code"
- button "Apply"
- button "Pay"`;

const SIGN_IN = `- heading "Sign in" [level=1]
- textbox "Email"
- textbox "Password"
- button "Sign in"`;

const on = { enabled: true };

describe("mailboxNeed: when the agent calls the mailbox/TOTP steps (ADR-0023 §4)", () => {
  it("a 'check your email' page → wait for the letter, take its link and open it", () => {
    const need = mailboxNeed(page(CHECK_EMAIL), on);
    expect(need?.signal).toBe("mail-link");
    expect(need?.steps?.map((s) => s.action)).toEqual(["mailbox.create", "mailbox.waitFor", "mailbox.extractLink", "mailbox.openLink"]);
  });

  it("a page asking for the code it e-mailed → wait for the letter and take the code", () => {
    const need = mailboxNeed(page(EMAILED_CODE), on);
    expect(need?.signal).toBe("mail-code");
    expect(need?.reason).toContain('"Verification code"');
    expect(need?.steps?.map((s) => s.action)).toEqual(["mailbox.create", "mailbox.waitFor", "mailbox.extractCode"]);
  });

  it("a TOTP prompt → a code from the secret NAMED in the options, never a value", () => {
    expect(mailboxNeed(page(TOTP_PROMPT), on)).toEqual({
      signal: "totp",
      reason: 'the field "Authentication code" asks for a one-time code',
      steps: [{ action: "totp.code", secretEnv: "TOTP_SECRET" }],
    });
    expect(mailboxNeed(page(TOTP_PROMPT), { enabled: true, totpSecretEnv: "APP_2FA_SECRET" })?.steps).toEqual([
      { action: "totp.code", secretEnv: "APP_2FA_SECRET" },
    ]);
  });

  it("a case step that names the letter fires on a page with no signal of its own", () => {
    expect(mailboxNeed(page(SIGN_IN, ["Open the confirmation link from the email"]), on)?.signal).toBe("mail-link");
    expect(mailboxNeed(page(SIGN_IN, ["Ввести код з листа"]), on)?.signal).toBe("mail-code");
    expect(mailboxNeed(page(SIGN_IN, ["Enter the 2FA code"]), on)?.signal).toBe("totp");
  });

  it("Ukrainian page text counts too", () => {
    expect(mailboxNeed(page(`- heading "Перевірте пошту" [level=1]\n- paragraph: Ми надіслали вам лист.`), on)?.signal).toBe("mail-link");
  });

  it("must not fire: promo and postal codes, a sign-in form, a step that only types an e-mail address", () => {
    expect(mailboxNeed(page(CHECKOUT), on)).toBeUndefined();
    expect(mailboxNeed(page(SIGN_IN, ["Fill Email with a valid address", "Click Sign in"]), on)).toBeUndefined();
    expect(mailboxNeed(page(`- heading "Inbox" [level=1]\n- textbox "Search mail"`), on)).toBeUndefined();
  });

  it("off: a page with a signal is only marked — no steps, the field is left alone", () => {
    for (const aria of [CHECK_EMAIL, EMAILED_CODE, TOTP_PROMPT]) {
      const need = mailboxNeed(page(aria), { enabled: false });
      expect(need?.signal).toBeDefined();
      expect(need?.steps).toBeUndefined();
    }
  });
});
