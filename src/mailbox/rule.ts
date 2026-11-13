import type { MailboxStep } from "./session.js";

/** What a page or a case asks for (ADR-0023 §4): a link from an e-mail, a code from an e-mail, or a TOTP code. */
export type MailboxSignal = "mail-link" | "mail-code" | "totp";

export interface MailboxNeed {
  signal: MailboxSignal;
  /** Which signal fired, for the progress line; never a value. */
  reason: string;
  /** The steps the agent runs. Absent when the mailbox steps are off: the step is only marked "needs e-mail/OTP". */
  steps?: MailboxStep[];
}

export interface MailboxEvidence {
  /** Interactive elements of the page (role and accessible name). */
  fields: ReadonlyArray<{ role: string; name?: string }>;
  /** Visible text of the page (the ARIA snapshot will do). */
  text: string;
  /** The steps of the designed or human-written cases. */
  steps: readonly string[];
}

export interface MailboxRuleOptions {
  /** A `MailboxSession` was passed: the agent may run the steps. Off → only the mark. */
  enabled: boolean;
  /** NAME of the variable holding the base32 TOTP secret. Default `TOTP_SECRET`. */
  totpSecretEnv?: string;
}

const INPUT_ROLES = new Set(["textbox", "spinbutton", "searchbox"]);
// A field asking for a one-time code; promo, postal, coupon and similar codes are not one.
const CODE_FIELD = /\b(?:code|otp|one[- ]?time|passcode|2fa|mfa|two[- ]factor|verification)\b|код|одноразов/i;
const NOT_OTP = /promo|postal|post ?code|zip|coupon|discount|voucher|gift|referral|invit|country|area|currency|поштов|промо|купон|знижк|країн/i;
const TOTP = /authenticator|authentication app|\btotp\b|\b2fa\b|\bmfa\b|two[- ]factor|автентифікатор|двофактор/i;
const MAIL_TEXT =
  /check your (?:e-?mail|inbox|mailbox)|(?:we(?:'ve| have)?|has been|was) sent (?:you )?(?:an? )?(?:\w+ )?(?:e-?mail|letter|message|link|code)|(?:confirm|verify) your e-?mail|перевірте (?:пошту|скриньку|e-?mail)|надіслали (?:вам )?(?:лист|код|посилання)|підтвердіть (?:e-?mail|пошту|електронну)/i;
// A case step that names the letter itself or a code from it, not a step that only types an e-mail address.
const MAIL_STEP =
  /(?:link|code|token) (?:from|in) the (?:e-?mail|letter|message|inbox)|(?:confirmation|verification|activation|reset) (?:e-?mail|link|letter|code)|open the (?:e-?mail|letter)|з листа|у листі|лист(?:ом)? (?:з|із) (?:посиланням|кодом)|(?:посилання|код) підтвердження/i;
const MAIL_CODE_STEP = /code|код/i;

/**
 * ADR-0023 §4: the agent calls the mailbox/TOTP steps itself only when they are enabled AND a signal fires — a field
 * asking for a code/OTP/2FA, page text saying an e-mail was sent, or a case step naming the letter or a code from it.
 * A rule over these signals, never an LLM verdict (ADR-0020). Off, a page with a signal is only marked.
 */
export function mailboxNeed(e: MailboxEvidence, o: MailboxRuleOptions): MailboxNeed | undefined {
  const codeField = e.fields.find((f) => INPUT_ROLES.has(f.role) && CODE_FIELD.test(f.name ?? "") && !NOT_OTP.test(f.name ?? ""));
  const step = e.steps.find((s) => MAIL_STEP.test(s) || TOTP.test(s));
  const mailText = MAIL_TEXT.exec(e.text)?.[0];
  const mailStep = step !== undefined && MAIL_STEP.test(step);
  const totpHint = TOTP.test(e.text) || (codeField !== undefined && TOTP.test(codeField.name ?? "")) || (step !== undefined && TOTP.test(step));

  let need: MailboxNeed;
  if (mailText || mailStep) {
    const code = codeField !== undefined || (mailStep && MAIL_CODE_STEP.test(step!));
    const why = mailText ? `the page says "${mailText}"` : "a case step reads an e-mail";
    need = code
      ? { signal: "mail-code", reason: `${why}${codeField ? ` and the field "${codeField.name}" asks for a code` : ""}` }
      : { signal: "mail-link", reason: why };
  } else if (codeField || totpHint) {
    need = { signal: "totp", reason: codeField ? `the field "${codeField.name}" asks for a one-time code` : "the page asks for an authenticator code" };
  } else {
    return undefined;
  }
  if (!o.enabled) return need;
  const steps: MailboxStep[] =
    need.signal === "totp"
      ? [{ action: "totp.code", secretEnv: o.totpSecretEnv ?? "TOTP_SECRET" }]
      : [
          { action: "mailbox.create" },
          { action: "mailbox.waitFor" },
          need.signal === "mail-code" ? { action: "mailbox.extractCode" } : { action: "mailbox.extractLink" },
          ...(need.signal === "mail-link" ? [{ action: "mailbox.openLink" } as const] : []),
        ];
  return { ...need, steps };
}
