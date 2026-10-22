export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: number;
  /** Plain-text body. May hold personal data and tokens: never log or persist it. */
  text: string;
}

export interface MessageFilter {
  /** Case-insensitive substring of the subject. */
  subject?: string;
  /** Case-insensitive substring of the sender. */
  from?: string;
}

export interface MailboxProvider {
  readonly name: string;
  /** One unique address per run. */
  createAddress(runId: string): Promise<string>;
  list(address: string): Promise<MailMessage[]>;
  /** Removes the address's messages (and the inbox if the provider allows). */
  cleanup(address: string): Promise<void>;
}

export interface WaitOptions extends MessageFilter {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
