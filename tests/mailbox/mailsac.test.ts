import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MailsacProvider, mailsacFromEnv, waitFor } from "../../src/mailbox/index.js";
import { FakeMailsac } from "./helpers.js";

const srv = new FakeMailsac();
beforeAll(() => srv.start());
afterAll(() => srv.stop());
beforeEach(() => {
  srv.inboxes.clear();
  srv.requests.length = 0;
  srv.failNext = [];
});
const noSleep = async (): Promise<void> => undefined;
const make = (extra = {}) => new MailsacProvider({ apiKey: srv.apiKey, baseUrl: srv.baseUrl + "/api", sleep: noSleep, ...extra });

describe("mailsacFromEnv", () => {
  it("needs MAILSAC_API_KEY and names the variable, not a value", () => {
    expect(() => mailsacFromEnv({})).toThrow(/MAILSAC_API_KEY/);
  });
  it("uses MAILSAC_ADDRESS as the fixed address", async () => {
    const p = mailsacFromEnv({ MAILSAC_API_KEY: "k", MAILSAC_ADDRESS: "fixed@mailsac.com" });
    expect(await p.createAddress("r1")).toBe("fixed@mailsac.com");
  });
  it("makes a unique address per run on the configured domain", async () => {
    const p = mailsacFromEnv({ MAILSAC_API_KEY: "k", MAILSAC_DOMAIN: "qa.example.org" });
    const a = await p.createAddress("Run 1");
    const b = await p.createAddress("Run 1");
    expect(a).toMatch(/^cairn-run-1-[0-9a-f]{12}@qa\.example\.org$/);
    expect(a).not.toBe(b);
  });
});

describe("MailsacProvider against the fake server", () => {
  it("lists messages with bodies and sends the key as a header only", async () => {
    srv.deliver("a@mailsac.com", { subject: "Confirm", from: [{ address: "noreply@x.io" }], text: "go https://app.test/verify?t=1" });
    const list = await make().list("a@mailsac.com");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "m1", subject: "Confirm", from: "noreply@x.io", text: "go https://app.test/verify?t=1" });
    expect(list[0]!.receivedAt).toBeGreaterThan(0);
    expect(srv.requests.every((r) => r.key === srv.apiKey && !r.path.includes(srv.apiKey))).toBe(true);
  });

  it("cleanup deletes every message", async () => {
    srv.deliver("a@mailsac.com", { subject: "1", from: [{ address: "x@y.z" }], text: "t" });
    srv.deliver("a@mailsac.com", { subject: "2", from: [{ address: "x@y.z" }], text: "t" });
    await make().cleanup("a@mailsac.com");
    expect(srv.inboxes.get("a@mailsac.com")).toEqual([]);
    expect(srv.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
  });

  it("retries 503/429 and then succeeds", async () => {
    srv.failNext = [503, 429];
    expect(await make().list("a@mailsac.com")).toEqual([]);
    expect(srv.requests).toHaveLength(3);
  });

  it("gives up after the attempts, with an error that carries neither key nor address", async () => {
    srv.failNext = [500, 500, 500, 500];
    const err = (await make({ attempts: 3 }).list("secret-box@mailsac.com").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/mailsac.*HTTP 500/);
    expect(err.message).not.toContain(srv.apiKey);
    expect(err.message).not.toContain("secret-box");
    expect(srv.requests).toHaveLength(3);
  });

  it("explains a rejected key without echoing it", async () => {
    const err = (await make({ apiKey: "wrong-KEY-value" }).list("a@mailsac.com").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/MAILSAC_API_KEY/);
    expect(err.message).not.toContain("wrong-KEY-value");
    expect(srv.requests).toHaveLength(1); // 401 is not retried
  });

  it("drives waitFor: a late message is found, a missing one times out clearly", async () => {
    const p = make();
    const addr = "late@mailsac.com";
    let t = 0;
    const found = await waitFor(p, addr, {
      subject: "welcome",
      timeoutMs: 10_000,
      intervalMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (t === 2000) srv.deliver(addr, { subject: "Welcome!", from: [{ address: "hi@x.io" }], text: "body" });
      },
    });
    expect(found.subject).toBe("Welcome!");
    t = 0;
    srv.inboxes.clear();
    await expect(
      waitFor(p, addr, { subject: "welcome", timeoutMs: 3000, intervalMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) }),
    ).rejects.toThrow(/no message matching subject=welcome/);
  });
});

// Optional live check: lists the inbox of the configured address only. Sends nothing, deletes nothing.
describe.skipIf(!process.env.MAILSAC_API_KEY || !process.env.MAILSAC_ADDRESS)("LIVE Mailsac (read-only)", () => {
  it("lists the configured inbox", async () => {
    const p = mailsacFromEnv(process.env);
    expect(Array.isArray(await p.list(process.env.MAILSAC_ADDRESS!))).toBe(true);
  });
});
