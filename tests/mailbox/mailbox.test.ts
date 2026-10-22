import { describe, expect, it } from "vitest";
import { FakeMailbox, describeForLog, extractCode, extractLink, waitFor } from "../../src/mailbox/index.js";

describe("mailbox with the fake provider", () => {
  it("gives a unique address per run and cleans up", async () => {
    const p = new FakeMailbox();
    const a = await p.createAddress("r1");
    const b = await p.createAddress("r2");
    expect(a).not.toBe(b);
    await p.cleanup(a);
    expect(p.has(a)).toBe(false);
    expect(p.has(b)).toBe(true);
  });

  it("retries until the message arrives and selects by subject and sender", async () => {
    const p = new FakeMailbox();
    const addr = await p.createAddress("r");
    let t = 0;
    let polls = 0;
    const msg = await waitFor(p, addr, {
      subject: "confirm",
      from: "noreply@",
      intervalMs: 1000,
      timeoutMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (++polls === 2) {
          p.deliver(addr, { from: "promo@x.io", subject: "Confirm now!", text: "no" });
          p.deliver(addr, { from: "noreply@x.io", subject: "Please Confirm your email", text: "Open https://app.test/verify?token=abc123 now" });
        }
      },
    });
    expect(msg.from).toBe("noreply@x.io");
    expect(polls).toBe(2);
    expect(extractLink(msg, "/verify")).toBe("https://app.test/verify?token=abc123");
  });

  it("times out without leaking message content", async () => {
    const p = new FakeMailbox();
    const addr = await p.createAddress("r");
    p.deliver(addr, { from: "a@b.c", subject: "other", text: "secret-body-123456" });
    let t = 0;
    const err = await waitFor(p, addr, {
      subject: "welcome",
      timeoutMs: 2000,
      intervalMs: 1000,
      now: () => t,
      sleep: async (ms) => void (t += ms),
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/no message matching subject=welcome/);
    expect(String(err)).not.toMatch(/secret-body/);
  });

  it("extracts a code and ignores longer digit runs", () => {
    const m = { id: "1", from: "a", subject: "s", receivedAt: 0, text: "order 12345678, your code: 482913." };
    expect(extractCode(m)).toBe("482913");
    expect(extractCode(m, /code:\s*(\d+)/)).toBe("482913");
  });

  it("log description has no body, no sender local part, no extracted secret", () => {
    const m = { id: "1", from: "noreply@x.io", subject: "Code 482913", receivedAt: 0, text: "BODY-PII" };
    const line = describeForLog(m, ["482913"]);
    expect(line).not.toMatch(/BODY-PII|noreply|482913/);
  });
});
