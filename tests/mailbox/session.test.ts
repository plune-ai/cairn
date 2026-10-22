import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MailboxSession, MailsacProvider } from "../../src/mailbox/index.js";
import { totpCode } from "../../src/totp/index.js";
import { FakeMailsac } from "./helpers.js";

const srv = new FakeMailsac();
beforeAll(() => srv.start());
afterAll(() => srv.stop());

const B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const session = (env: Record<string, string> = { TOTP_SECRET: B32 }) =>
  new MailboxSession({
    provider: new MailsacProvider({ apiKey: srv.apiKey, baseUrl: srv.baseUrl + "/api", sleep: async () => undefined }),
    runId: "run7",
    env,
    wait: { timeoutMs: 100, intervalMs: 10 },
  });
const errOf = async (p: Promise<unknown>): Promise<Error> => (await p.catch((e: Error) => e)) as Error;

describe("MailboxSession: sign-up with an e-mail link, end to end on the fake server", () => {
  it("create, wait, extract link, open, cleanup; nothing leaks through redact", async () => {
    const s = session();
    expect(await s.run({ action: "mailbox.create" })).toBe("address created"); // steps return pointers, not values
    const address = s.resolve("{{mailbox.address}}");
    expect(address).toMatch(/^cairn-run7-/);
    srv.deliver(address, { subject: "Please confirm", from: [{ address: "noreply@app.test" }], text: "Click https://app.test/verify?token=TOK123 to confirm" });
    expect(await s.run({ action: "mailbox.waitFor", subject: "confirm", from: "noreply@" })).toBe("message found");
    expect(await s.run({ action: "mailbox.extractLink", contains: "/verify" })).toBe("link found");
    const navigated: string[] = [];
    await s.run({ action: "mailbox.openLink" }, { act: async (a) => (navigated.push(a.kind === "navigate" ? a.url : ""), { ok: true }) });
    expect(navigated).toEqual(["https://app.test/verify?token=TOK123"]);

    const clean = s.redact(`visited https://app.test/verify?token=TOK123 as ${address}`);
    expect(clean).not.toContain("TOK123");
    expect(clean).not.toContain(address);

    await s.cleanup();
    expect(srv.inboxes.get(address)).toEqual([]);
  });

  it("code extraction registers the code as a secret", async () => {
    const s = session();
    await s.run({ action: "mailbox.create" });
    const address = s.resolve("{{mailbox.address}}");
    srv.deliver(address, { subject: "Your code", from: [{ address: "a@b.c" }], text: "Code: 482913" });
    await s.run({ action: "mailbox.waitFor", subject: "code" });
    expect(await s.run({ action: "mailbox.extractCode" })).toBe("code found");
    expect(s.resolve("{{mailbox.code}}")).toBe("482913");
    expect(s.redact("typed 482913")).not.toContain("482913");
  });

  it("a timeout is a clear error, does not hang and does not leak the address", async () => {
    const s = session();
    await s.run({ action: "mailbox.create" });
    const address = s.resolve("{{mailbox.address}}");
    const err = await errOf(s.run({ action: "mailbox.waitFor", subject: "never" }));
    expect(err.message).toMatch(/^mailbox\.waitFor: no message matching subject=never/);
    expect(err.message).not.toContain(address);
  });

  it("a missing link is a step error without the body", async () => {
    const s = session();
    await s.run({ action: "mailbox.create" });
    const address = s.resolve("{{mailbox.address}}");
    srv.deliver(address, { subject: "hello", from: [{ address: "a@b.c" }], text: "BODY-PII no link here" });
    await s.run({ action: "mailbox.waitFor" });
    const err = await errOf(s.run({ action: "mailbox.extractLink" }));
    expect(err.message).toMatch(/no link/);
    expect(err.message).not.toContain("BODY-PII");
  });

  it("steps before their inputs exist fail with a hint, not a crash", async () => {
    const err = await errOf(session().run({ action: "mailbox.waitFor" }));
    expect(err.message).toMatch(/mailbox\.create/);
  });

  it("placeholders that were never produced are an error, not an empty string", () => {
    expect(() => session().resolve("go {{mailbox.link}}")).toThrow(/mailbox\.link/);
  });
});

describe("totp.code", () => {
  const at = 1_111_111_111_000 - 15_000;

  it("reads the secret from the named variable; the secret and the code are redacted", async () => {
    const s = session();
    expect(await s.run({ action: "totp.code", secretEnv: "TOTP_SECRET" }, undefined, { now: at })).toBe("code generated");
    const code = s.resolve("{{totp.code}}");
    expect(code).toBe(totpCode(B32, { now: at }));
    const out = s.redact(`secret ${B32} code ${code}`);
    expect(out).not.toContain(B32);
    expect(out).not.toContain(code);
  });

  it("an unset variable names the variable only", async () => {
    expect((await errOf(session({}).run({ action: "totp.code", secretEnv: "NOPE_SECRET" }))).message).toMatch(/NOPE_SECRET is not set/);
  });

  it("rejects a value-looking secretEnv without echoing it", async () => {
    const err = await errOf(session({}).run({ action: "totp.code", secretEnv: "JBSWY3DP-EHPK3PXP!" }));
    expect(err.message).toMatch(/NAME of an environment variable/);
    expect(err.message).not.toContain("JBSWY3DP");
  });
});
