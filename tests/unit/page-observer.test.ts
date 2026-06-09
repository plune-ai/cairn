import { describe, it, expect } from "vitest";
import { capture } from "../../src/observe/index.js";
import type { BrowserGateway } from "../../src/browser/gateway.js";
import type { Observation } from "../../src/browser/types.js";

const fakeObs: Observation = {
  url: "http://x/login",
  screenshotB64: "QUJD",
  ariaSnapshot: `- main:\n  - textbox "Email"\n  - button "Sign In"`,
  capturedBy: "lib",
};

/** Fake gateway — capture() is tested without a browser. */
const fakeGateway: BrowserGateway = {
  observe: async () => fakeObs,
  act: async () => ({ ok: true }),
  verify: async (els) => els.map((e) => ({ ...e, count: 1, verified: true })),
  getState: async () => ({ visible: true, enabled: true }),
  session: () => ({ load: async () => undefined, save: async () => ({ cookies: [], origins: [] }) }),
  runTests: async () => ({ passed: 0, failed: 0, flaky: 0 }),
  close: async () => undefined,
};

describe("PageObserver.capture", () => {
  it("normalizes Observation → PageStudy with parsed elements", async () => {
    const study = await capture(fakeGateway, "http://x/login");
    expect(study.url).toBe("http://x/login");
    expect(study.capturedBy).toBe("lib");
    expect(study.ariaYaml).toContain("Email");
    expect(study.screenshotB64).toBe("QUJD");
    expect(
      study.elements.some((e) => e.role === "button" && e.name === "Sign In" && e.interactive),
    ).toBe(true);
  });
});
