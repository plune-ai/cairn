import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeMsg {
  _id: string;
  subject: string;
  from: Array<{ address: string; name?: string }>;
  received: string;
  text: string;
}

/** Local stand-in for the three Mailsac endpoints the provider uses. Records every request. */
export class FakeMailsac {
  readonly inboxes = new Map<string, FakeMsg[]>();
  readonly requests: Array<{ method: string; path: string; key: string | undefined }> = [];
  /** HTTP statuses to answer with (in order) before behaving normally, e.g. [503, 429]. */
  failNext: number[] = [];
  private server: Server = createServer((req, res) => this.handle(req, res));
  baseUrl = "";

  constructor(readonly apiKey = "test-key-NOT-REAL") {}

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  deliver(address: string, m: Omit<FakeMsg, "_id" | "received"> & { received?: string }): void {
    const box = this.inboxes.get(address) ?? [];
    box.push({ _id: `m${box.length + 1}`, received: new Date().toISOString(), ...m });
    this.inboxes.set(address, box);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const key = req.headers["mailsac-key"] as string | undefined;
    const path = decodeURIComponent(req.url ?? "");
    this.requests.push({ method: req.method ?? "", path, key });
    const fail = this.failNext.shift();
    if (fail) return void res.writeHead(fail).end("fail");
    if (key !== this.apiKey) return void res.writeHead(401).end("nope");
    let m: RegExpMatchArray | null;
    if (req.method === "GET" && (m = path.match(/^\/api\/addresses\/([^/]+)\/messages$/))) {
      const list = (this.inboxes.get(m[1]!) ?? []).map((x) => ({ _id: x._id, subject: x.subject, from: x.from, received: x.received }));
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/text\/([^/]+)\/([^/]+)$/))) {
      const id = m[2];
      const msg = (this.inboxes.get(m[1]!) ?? []).find((x) => x._id === id);
      return void (msg ? res.writeHead(200, { "content-type": "text/plain" }).end(msg.text) : res.writeHead(404).end());
    }
    if (req.method === "DELETE" && (m = path.match(/^\/api\/addresses\/([^/]+)\/messages\/([^/]+)$/))) {
      const id = m[2];
      this.inboxes.set(m[1]!, (this.inboxes.get(m[1]!) ?? []).filter((x) => x._id !== id));
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end();
  }
}
