import { describe, it, expect } from "vitest";
import { redact, basicAuthSecrets, REDACTED } from "../../src/environment/redact.js";

describe("redact", () => {
  it.each([
    ["password", "login with password=Sup3rS3cret! failed"],
    ["token", 'request {"token": "tok_live_abc123"} sent'],
    ["otp", "otp: 481516 was entered"],
    ["PASSWORD (any case, prefixed key)", "DB_PASSWORD=hunter2 set"],
    ["authorization header", "Authorization: Basic dXNlcjpwYXNz"],
    ["url userinfo", "GET https://bob:hunter2@staging.example.com/"],
  ])("masks a secret shaped as %s", (_n, line) => {
    const out = redact(line);
    expect(out).toContain(REDACTED);
    for (const leak of ["Sup3rS3cret!", "tok_live_abc123", "481516", "hunter2", "dXNlcjpwYXNz"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("masks the exact secret values (longest first) wherever they appear", () => {
    const secrets = basicAuthSecrets("bob", "pa55word");
    const out = redact(`sent bob:pa55word as ${Buffer.from("bob:pa55word").toString("base64")}; echo pa55word`, secrets);
    expect(out).not.toContain("pa55word");
    expect(out).not.toContain(Buffer.from("bob:pa55word").toString("base64"));
  });

  it("leaves ordinary text alone", () => {
    expect(redact("Start page reached: http://localhost:3000/dashboard")).toBe("Start page reached: http://localhost:3000/dashboard");
  });
});
