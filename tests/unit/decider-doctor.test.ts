import { describe, it, expect, vi } from "vitest";
import { deciderDoctorReport } from "../../src/decider/index.js";

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("cairn doctor — decision layer section (spec §4)", () => {
  it("off → nothing printed, no request made", async () => {
    const fetchFn = respond({});
    expect(await deciderDoctorReport({}, fetchFn)).toEqual([]);
    expect(await deciderDoctorReport({ DECIDER: "off", TYPESAFE_API_KEY: "k" }, fetchFn)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a config error → one clear line, no crash", async () => {
    const text = (await deciderDoctorReport({ DECIDER: "jev" })).join("\n");
    expect(text).toMatch(/✗ .*TYPESAFE_API_KEY/);
  });

  it("prints provider, where the data goes, and the result + latency of one real noul call", async () => {
    const fetchFn = respond({
      model: "laya-rl-agent",
      answers: { q: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.5 } },
    });
    const text = (
      await deciderDoctorReport({ DECIDER: "laya", DECIDER_BASE_URL: "http://127.0.0.1:8000", LAYA_API_KEY: "s3cr3t-laya" }, fetchFn)
    ).join("\n");
    expect(text).toContain("Provider: laya");
    expect(text).toContain("this machine (localhost)");
    expect(text).toMatch(/✓ Test call \(noul\): \d+ ms · answered by laya-rl-agent/);
    expect(text).not.toContain("s3cr3t-laya"); // never prints a key
    expect(text).not.toContain("shadow");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("shadow mode is said out loud — a pilot must know its answers are only recorded", async () => {
    const fetchFn = respond({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } } });
    const text = (await deciderDoctorReport({ DECIDER: "jev", TYPESAFE_API_KEY: "k", DECIDER_SHADOW: "1" }, fetchFn)).join("\n");
    expect(text).toContain("shadow mode — answers are recorded, never acted on");
  });

  it("the cloud destination is spelled out", async () => {
    const fetchFn = respond({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } } });
    const text = (await deciderDoctorReport({ DECIDER: "jev", TYPESAFE_API_KEY: "k" }, fetchFn)).join("\n");
    expect(text).toContain("TypeSafe cloud (api.typesafe.ai)");
    expect(text).toContain("leave this machine");
  });

  it("a failing server is reported, not thrown", async () => {
    const text = (await deciderDoctorReport({ DECIDER: "jev", TYPESAFE_API_KEY: "bad" }, respond({}, 401))).join("\n");
    expect(text).toMatch(/✗ Test call failed: HTTP 401/);
  });
});
