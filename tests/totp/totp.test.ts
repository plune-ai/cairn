import { describe, expect, it } from "vitest";
import { base32Decode, freshTotp, msUntilNextWindow, secretFromEnv, totpFromKey } from "../../src/totp/index.js";

const sha1 = Buffer.from("12345678901234567890");
const sha256 = Buffer.from("12345678901234567890123456789012");
const sha512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");
const B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// RFC 6238 Appendix B: [time, sha1, sha256, sha512] (8 digits)
const vectors: Array<[number, string, string, string]> = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("totp RFC 6238 vectors", () => {
  for (const [t, a, b, c] of vectors) {
    it("T=" + t, () => {
      expect(totpFromKey(sha1, { now: t * 1000, digits: 8 })).toBe(a);
      expect(totpFromKey(sha256, { now: t * 1000, digits: 8, algorithm: "sha256" })).toBe(b);
      expect(totpFromKey(sha512, { now: t * 1000, digits: 8, algorithm: "sha512" })).toBe(c);
    });
  }
});

describe("helpers", () => {
  it("decodes base32", () => {
    expect(base32Decode(B32).toString()).toBe("12345678901234567890");
  });
  it("rejects bad base32 without echoing it", () => {
    expect(() => base32Decode("not*base32")).toThrow(/not valid base32$/);
  });
  it("window edge: stable inside a window, changes at the boundary", () => {
    expect(totpFromKey(sha1, { now: 29_999 })).toBe(totpFromKey(sha1, { now: 0 }));
    expect(totpFromKey(sha1, { now: 30_000 })).not.toBe(totpFromKey(sha1, { now: 29_999 }));
    expect(msUntilNextWindow(29_000)).toBe(1000);
  });
  it("freshTotp waits for the next window when under the margin", async () => {
    const slept: number[] = [];
    const code = await freshTotp(B32, { now: 28_000, sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([2050]);
    expect(code).toBe(totpFromKey(sha1, { now: 30_050 }));
  });
  it("freshTotp does not wait with enough time left", async () => {
    const slept: number[] = [];
    await freshTotp(B32, { now: 10_000, sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([]);
  });
  it("secretFromEnv names the variable, never the value", () => {
    expect(secretFromEnv("X", { X: "abc" })).toBe("abc");
    expect(() => secretFromEnv("X", {})).toThrow(/X is not set/);
  });
});
