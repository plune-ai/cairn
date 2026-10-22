import type { MailboxProvider, MailMessage } from "./types.js";

/** In-memory provider for tests; `deliver` plays the role of the product sending an e-mail. */
export class FakeMailbox implements MailboxProvider {
  readonly name = "fake";
  private boxes = new Map<string, MailMessage[]>();
  private seq = 0;

  async createAddress(runId: string): Promise<string> {
    const address = `cairn-${runId}-${++this.seq}@fake.invalid`;
    this.boxes.set(address, []);
    return address;
  }

  deliver(address: string, msg: Omit<MailMessage, "id" | "receivedAt"> & { receivedAt?: number }): void {
    const box = this.boxes.get(address);
    if (!box) throw new Error("fake mailbox: unknown address");
    box.push({ id: String(++this.seq), receivedAt: msg.receivedAt ?? Date.now(), ...msg });
  }

  async list(address: string): Promise<MailMessage[]> {
    return [...(this.boxes.get(address) ?? [])];
  }

  async cleanup(address: string): Promise<void> {
    this.boxes.delete(address);
  }

  has(address: string): boolean {
    return this.boxes.has(address);
  }
}
