import { randomBytes } from "node:crypto";
import type { MailboxProvider, MailMessage } from "./types.js";

type Env = Record<string, string | undefined>;

export interface MailsacOptions {
  apiKey: string;
  /** Fixed address (MAILSAC_ADDRESS). Without it every run gets its own unguessable one. */
  address?: string;
  /** Domain for generated addresses (MAILSAC_DOMAIN); default mailsac.com. Use a private one for personal data. */
  domain?: string;
  /** API root; overridden in tests to point at a local server. */
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per request for 429/5xx/network errors. Default 3. */
  attempts?: number;
  requestTimeoutMs?: number;
}

/**
 * Builds the provider from MAILSAC_API_KEY (required), MAILSAC_ADDRESS and MAILSAC_DOMAIN (optional).
 * The error names the variable, never a value.
 */
export function mailsacFromEnv(env: Env = process.env): MailsacProvider {
  const apiKey = env.MAILSAC_API_KEY;
  if (!apiKey) throw new Error("mailbox: environment variable MAILSAC_API_KEY is not set");
  return new MailsacProvider({ apiKey, address: env.MAILSAC_ADDRESS || undefined, domain: env.MAILSAC_DOMAIN || undefined });
}

interface RawMessage {
  _id: string;
  subject?: string;
  from?: Array<{ address?: string }> | string;
  received?: string;
}

/**
 * Mailsac REST provider (`Mailsac-Key` header). Endpoints, as in Mailsac's OpenAPI spec:
 * GET /addresses/{email}/messages, GET /text/{email}/{id}, DELETE /addresses/{email}/messages/{id}.
 * The key is sent only as a header; no error text contains the key, the address or a message body.
 */
export class MailsacProvider implements MailboxProvider {
  readonly name = "mailsac";
  private readonly o: Required<Pick<MailsacOptions, "baseUrl" | "attempts" | "requestTimeoutMs" | "domain">> & MailsacOptions;
  private readonly bodies = new Map<string, string>();

  constructor(opts: MailsacOptions) {
    this.o = { baseUrl: "https://mailsac.com/api", attempts: 3, requestTimeoutMs: 15_000, domain: "mailsac.com", ...opts };
  }

  async createAddress(runId: string): Promise<string> {
    if (this.o.address) return this.o.address;
    const safe = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
    return `cairn-${safe}-${randomBytes(6).toString("hex")}@${this.o.domain}`;
  }

  async list(address: string): Promise<MailMessage[]> {
    const raw = (await (await this.request("GET", `/addresses/${encodeURIComponent(address)}/messages`, "list messages")).json()) as RawMessage[];
    const out: MailMessage[] = [];
    for (const m of raw) {
      const key = `${address}/${m._id}`;
      let text = this.bodies.get(key);
      if (text === undefined) {
        text = await (await this.request("GET", `/text/${encodeURIComponent(address)}/${encodeURIComponent(m._id)}`, "read message")).text();
        this.bodies.set(key, text);
      }
      const from = typeof m.from === "string" ? m.from : (m.from?.[0]?.address ?? "");
      out.push({ id: m._id, from, subject: m.subject ?? "", receivedAt: Date.parse(m.received ?? "") || 0, text });
    }
    return out;
  }

  async cleanup(address: string): Promise<void> {
    const raw = (await (await this.request("GET", `/addresses/${encodeURIComponent(address)}/messages`, "list messages")).json()) as RawMessage[];
    for (const m of raw) {
      await this.request("DELETE", `/addresses/${encodeURIComponent(address)}/messages/${encodeURIComponent(m._id)}`, "delete message");
      this.bodies.delete(`${address}/${m._id}`);
    }
  }

  private async request(method: string, path: string, what: string): Promise<Response> {
    const doFetch = this.o.fetch ?? fetch;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last = "";
    for (let attempt = 1; attempt <= this.o.attempts; attempt++) {
      try {
        const res = await doFetch(this.o.baseUrl + path, {
          method,
          headers: { "Mailsac-Key": this.o.apiKey },
          signal: AbortSignal.timeout(this.o.requestTimeoutMs),
        });
        if (res.ok) return res;
        if (res.status === 401 || res.status === 403) {
          throw new Error(`mailbox (mailsac): ${what} rejected with HTTP ${res.status} - check MAILSAC_API_KEY`);
        }
        if (res.status !== 429 && res.status < 500) throw new Error(`mailbox (mailsac): ${what} failed with HTTP ${res.status}`);
        last = `HTTP ${res.status}`;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("mailbox (mailsac)")) throw e;
        last = "network error or timeout"; // fetch's own message can echo the URL, which holds the address
      }
      if (attempt < this.o.attempts) await sleep(500 * 2 ** (attempt - 1));
    }
    throw new Error(`mailbox (mailsac): ${what} failed after ${this.o.attempts} attempts (${last})`);
  }
}
