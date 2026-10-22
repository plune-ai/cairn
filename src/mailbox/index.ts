import type { MailboxProvider, MailMessage, MessageFilter, WaitOptions } from "./types.js";
import { redact } from "../decider/redact.js";

export type { MailboxProvider, MailMessage, MessageFilter, WaitOptions } from "./types.js";
export { FakeMailbox } from "./fake.js";

const matches = (m: MailMessage, f: MessageFilter): boolean =>
  (!f.subject || m.subject.toLowerCase().includes(f.subject.toLowerCase())) &&
  (!f.from || m.from.toLowerCase().includes(f.from.toLowerCase()));

/** Polls until a message matching the filter arrives; the newest match wins. Throws a body-free error on timeout. */
export async function waitFor(provider: MailboxProvider, address: string, opts: WaitOptions = {}): Promise<MailMessage> {
  const { timeoutMs = 60_000, intervalMs = 3_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = opts;
  const deadline = now() + timeoutMs;
  for (;;) {
    const hit = (await provider.list(address)).filter((m) => matches(m, opts)).sort((a, b) => b.receivedAt - a.receivedAt)[0];
    if (hit) return hit;
    if (now() + intervalMs > deadline) {
      throw new Error(`mailbox.waitFor: no message matching subject=${opts.subject ?? "*"} from=${opts.from ?? "*"} within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/** First http(s) link in the body, optionally the first whose URL contains `contains`. */
export function extractLink(msg: MailMessage, contains?: string): string | undefined {
  const links = msg.text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  return contains ? links.find((l) => l.includes(contains)) : links[0];
}

/** First standalone digit run of `length` digits (default 6), or the first capture of a custom pattern. */
export function extractCode(msg: MailMessage, pattern?: RegExp, length = 6): string | undefined {
  if (pattern) return pattern.exec(msg.text)?.[1];
  return new RegExp(`(?<!\\d)(\\d{${length}})(?!\\d)`).exec(msg.text)?.[1];
}

/** Log-safe description of a message: no body, no address; extracted values and addresses are scrubbed. */
export function describeForLog(msg: MailMessage, secrets: readonly string[]): string {
  return redact(`message from=${msg.from.replace(/.*@/, "***@")} subject=${msg.subject}`, secrets);
}
