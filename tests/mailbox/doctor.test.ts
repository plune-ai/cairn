import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mailboxDoctorReport } from "../../src/mailbox/doctor.js";
import { FakeMailsac } from "./helpers.js";

const srv = new FakeMailsac("mk-doctor-NOT-REAL-77");
beforeAll(() => srv.start());
afterAll(() => srv.stop());
beforeEach(() => {
  srv.requests.length = 0;
  srv.failNext = [];
});
const report = async (env: Record<string, string>) => (await mailboxDoctorReport(env, { baseUrl: srv.baseUrl + "/api" })).join("\n");

describe("cairn doctor — test mailbox section (ADR-0023)", () => {
  it("absent: says the key is not set and calls nothing", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const text = (await mailboxDoctorReport({}, { fetch: fetchFn })).join("\n");
    expect(text).toMatch(/MAILSAC_API_KEY is not set/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("present on a private domain: the service answers, the key is never printed", async () => {
    const text = await report({ MAILSAC_API_KEY: srv.apiKey, MAILSAC_DOMAIN: "qa.example.org" });
    expect(text).toContain("✓ MAILSAC_API_KEY is set");
    expect(text).toContain("Domain: qa.example.org");
    expect(text).not.toContain("public");
    expect(text).toMatch(/✓ Mailsac answered for qa\.example\.org: key accepted \(\d+ ms\)/);
    expect(text).not.toContain(srv.apiKey);
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0]!.path).toMatch(/^\/api\/addresses\/cairn-doctor-[0-9a-f]{12}@qa\.example\.org\/messages$/);
  });

  it("the default public domain is flagged", async () => {
    expect(await report({ MAILSAC_API_KEY: srv.apiKey })).toMatch(/⚠ Domain: mailsac\.com is public/);
    expect(await report({ MAILSAC_API_KEY: srv.apiKey, MAILSAC_ADDRESS: "box@team.example.org" })).toContain("Domain: team.example.org");
  });

  it("rejected: the service's reply, with neither the key nor the address", async () => {
    const wrong = "mk-WRONG-NOT-REAL-12";
    const text = await report({ MAILSAC_API_KEY: wrong, MAILSAC_ADDRESS: "private-box@team.example.org" });
    expect(text).toMatch(/✗ mailbox \(mailsac\): list messages rejected with HTTP 401 - check MAILSAC_API_KEY/);
    expect(text).not.toContain(wrong);
    expect(text).not.toContain("private-box");
  });

  it("an unreachable service is a finding, not a crash", async () => {
    srv.failNext = [503];
    expect(await report({ MAILSAC_API_KEY: srv.apiKey, MAILSAC_DOMAIN: "qa.example.org" })).toMatch(/✗ mailbox \(mailsac\): list messages failed after 1 attempts \(HTTP 503\)/);
  });
});
