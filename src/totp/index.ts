import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (no padding required, case and spaces ignored). */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("totp: secret is not valid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  /** Unix time in ms; defaults to Date.now(). */
  now?: number;
  digits?: number;
  period?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}

/** RFC 6238 / RFC 4226 code for a raw key. */
export function totpFromKey(key: Buffer, opts: TotpOptions = {}): string {
  const { now = Date.now(), digits = 6, period = 30, algorithm = "sha1" } = opts;
  const counter = BigInt(Math.floor(now / 1000 / period));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const h = createHmac(algorithm, key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpCode = (base32Secret: string, opts: TotpOptions = {}): string =>
  totpFromKey(base32Decode(base32Secret), opts);

export function msUntilNextWindow(now = Date.now(), period = 30): number {
  const p = period * 1000;
  return p - (now % p);
}

export interface FreshTotpOptions extends TotpOptions {
  /** If fewer ms than this remain in the window, wait for the next one. Default 3000. */
  minRemainingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Window-edge policy: a code read in the last `minRemainingMs` of a window may expire before the server checks it,
 * so wait for the next window and return that code. Never returns a code about to expire.
 */
export async function freshTotp(base32Secret: string, opts: FreshTotpOptions = {}): Promise<string> {
  const { minRemainingMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), period = 30 } = opts;
  let now = opts.now ?? Date.now();
  const left = msUntilNextWindow(now, period);
  if (left < minRemainingMs) {
    await sleep(left + 50);
    now += left + 50;
  }
  return totpCode(base32Secret, { ...opts, now });
}

/** Reads the base32 secret from an environment variable by NAME; the value never leaves this function except as a code. */
export function secretFromEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`totp: environment variable ${name} is not set`);
  return v;
}
