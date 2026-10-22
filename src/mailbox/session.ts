import { redact } from "../environment/redact.js";
import { extractCode, extractLink, waitFor } from "./index.js";
import type { MailboxProvider, MailMessage, WaitOptions } from "./types.js";
import { freshTotp, secretFromEnv } from "../totp/index.js";
import type { FreshTotpOptions } from "../totp/index.js";

/** The out-of-browser steps of a scenario (ADR-0023). Values are never in a step: only filters and variable NAMES. */
export type MailboxStep =
  | { action: "mailbox.create" }
  | { action: "mailbox.waitFor"; subject?: string; from?: string; timeoutMs?: number }
  | { action: "mailbox.extractLink"; contains?: string }
  | { action: "mailbox.extractCode"; pattern?: string; length?: number }
  | { action: "mailbox.openLink" }
  | { action: "totp.code"; secretEnv: string };

/** The only browser capability a step needs; `BrowserGateway` satisfies it. */
export interface Navigator {
  act(action: { kind: "navigate"; url: string }): Promise<{ ok: boolean; error?: string }>;
}

export interface MailboxSessionOptions {
  provider: MailboxProvider;
  runId: string;
  env?: Record<string, string | undefined>;
  wait?: Pick<WaitOptions, "timeoutMs" | "intervalMs">;
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{\{\s*(mailbox\.address|mailbox\.link|mailbox\.code|totp\.code)\s*\}\}/g;

/**
 * Holds the per-run state of a scenario that reads e-mail or needs a TOTP code. Every address, extracted value
 * and TOTP secret is registered in `secrets` the moment it appears; pass {@link redact} (or `secrets`) to
 * every sink (progress, run.log, reports, errors). Steps return a pointer ("link found"), never the value; the
 * executor reads values late via {@link resolve}, only for `fill`/`navigate`.
 */
export class MailboxSession {
  private readonly values: Partial<Record<"mailbox.address" | "mailbox.link" | "mailbox.code" | "totp.code", string>> = {};
  private message: MailMessage | undefined;
  private readonly known = new Set<string>();

  constructor(private readonly o: MailboxSessionOptions) {}

  /** Every secret value seen so far (for `redact()` in other layers). */
  get secrets(): string[] {
    return [...this.known];
  }

  redact(text: string): string {
    return redact(text, this.secrets, false);
  }

  private register(...vs: Array<string | undefined>): void {
    for (const v of vs) if (v) this.known.add(v);
  }

  /** Expands {{mailbox.address}}, {{mailbox.link}}, {{mailbox.code}}, {{totp.code}}. An unproduced one is an error. */
  resolve(text: string): string {
    return text.replace(PLACEHOLDER, (_m, name: keyof MailboxSession["values"]) => {
      const v = this.values[name];
      if (v === undefined) throw new Error(`mailbox: {{${name}}} used before the step that produces it`);
      return v;
    });
  }

  async run(step: MailboxStep, nav?: Navigator, totp?: Pick<FreshTotpOptions, "now" | "sleep">): Promise<string> {
    try {
      return await this.exec(step, nav, totp);
    } catch (e) {
      throw new Error(this.redact(e instanceof Error ? e.message : String(e)));
    }
  }

  private async exec(step: MailboxStep, nav?: Navigator, totp?: Pick<FreshTotpOptions, "now" | "sleep">): Promise<string> {
    switch (step.action) {
      case "mailbox.create": {
        const address = await this.o.provider.createAddress(this.o.runId);
        this.values["mailbox.address"] = address;
        this.register(address, address.split("@")[0]);
        return "address created";
      }
      case "mailbox.waitFor": {
        const address = this.need("mailbox.address", "mailbox.create");
        this.message = await waitFor(this.o.provider, address, { ...this.o.wait, subject: step.subject, from: step.from, timeoutMs: step.timeoutMs ?? this.o.wait?.timeoutMs });
        return "message found";
      }
      case "mailbox.extractLink": {
        const link = extractLink(this.msg(), step.contains);
        if (!link) throw new Error(`mailbox.extractLink: no link${step.contains ? ` containing "${step.contains}"` : ""} in the message`);
        this.values["mailbox.link"] = link;
        this.register(link);
        return "link found";
      }
      case "mailbox.extractCode": {
        const code = extractCode(this.msg(), step.pattern ? new RegExp(step.pattern) : undefined, step.length);
        if (!code) throw new Error("mailbox.extractCode: no code in the message");
        this.values["mailbox.code"] = code;
        this.register(code);
        return "code found";
      }
      case "mailbox.openLink": {
        const link = this.need("mailbox.link", "mailbox.extractLink");
        if (!nav) throw new Error("mailbox.openLink: no browser to open the link in");
        const r = await nav.act({ kind: "navigate", url: link });
        if (!r.ok) throw new Error(`mailbox.openLink: navigation failed${r.error ? `: ${r.error}` : ""}`);
        return "link opened";
      }
      case "totp.code": {
        if (!VAR_NAME.test(step.secretEnv)) throw new Error("totp.code: secretEnv must be the NAME of an environment variable, not a value");
        const secret = secretFromEnv(step.secretEnv, this.o.env);
        this.register(secret, secret.replace(/[\s=-]/g, ""));
        const code = await freshTotp(secret, totp);
        this.values["totp.code"] = code;
        this.register(code);
        return "code generated";
      }
    }
  }

  private need(name: keyof MailboxSession["values"], producer: string): string {
    const v = this.values[name];
    if (v === undefined) throw new Error(`mailbox: ${producer} must run first`);
    return v;
  }

  private msg(): MailMessage {
    if (!this.message) throw new Error("mailbox: mailbox.waitFor must run first");
    return this.message;
  }

  /** Call from `finally`, also when the run failed. */
  async cleanup(): Promise<void> {
    const address = this.values["mailbox.address"];
    if (address) await this.o.provider.cleanup(address).catch((e: unknown) => {
      throw new Error(this.redact(e instanceof Error ? e.message : String(e)));
    });
  }
}
