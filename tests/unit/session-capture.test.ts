import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSession } from "../../src/session/index.js";
import type { BrowserGateway } from "../../src/browser/index.js";
import type { StorageState } from "../../src/browser/types.js";

const SECRET = "secret-cookie-value-DO-NOT-LOG";
const captured: StorageState = {
  cookies: [{ name: "auth", value: SECRET, domain: "app.test", path: "/" }],
  origins: [{ origin: "https://app.test", localStorage: [{ name: "tok", value: SECRET }] }],
};

interface Rec {
  observed: string[];
  saved: number;
  closed: number;
}

function fakeGateway(rec: Rec): BrowserGateway {
  return {
    observe: async (o) => {
      if (o.url) rec.observed.push(o.url);
      return { url: o.url ?? "", screenshotB64: "", ariaSnapshot: "", capturedBy: "lib" };
    },
    act: async () => ({ ok: true }),
    verify: async (els) => els.map((e) => ({ ...e, count: 1, verified: true })),
    getState: async () => ({ visible: true, enabled: true }),
    session: () => ({
      load: async () => undefined,
      save: async () => {
        rec.saved += 1;
        return captured;
      },
    }),
    runTests: async () => ({ passed: 0, failed: 0, flaky: 0 }),
    close: async () => {
      rec.closed += 1;
    },
  };
}

describe("captureSession", () => {
  it("observes the login URL, saves storageState via SessionStore, returns the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-cap-"));
    try {
      const rec: Rec = { observed: [], saved: 0, closed: 0 };
      const res = await captureSession({
        url: "https://app.test/login",
        name: "myapp",
        dir,
        gateway: fakeGateway(rec),
        waitForLogin: async () => undefined,
      });
      expect(rec.observed).toEqual(["https://app.test/login"]);
      expect(rec.saved).toBe(1);
      expect(rec.closed).toBe(1);
      expect(res.name).toBe("myapp");
      expect(res.path).toBe(join(dir, "myapp.storageState.json"));
      const onDisk = JSON.parse(await readFile(res.path, "utf8")) as StorageState;
      expect(onDisk).toEqual(captured);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never logs secret cookie/token values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-cap-"));
    try {
      const rec: Rec = { observed: [], saved: 0, closed: 0 };
      const logs: string[] = [];
      await captureSession({
        url: "https://app.test/login",
        name: "myapp",
        dir,
        gateway: fakeGateway(rec),
        waitForLogin: async () => undefined,
        onLog: (m) => logs.push(m),
      });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join("\n")).not.toContain(SECRET);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults the session name from the URL hostname when omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-cap-"));
    try {
      const rec: Rec = { observed: [], saved: 0, closed: 0 };
      const res = await captureSession({
        url: "https://My-App.Example.com/login",
        dir,
        gateway: fakeGateway(rec),
        waitForLogin: async () => undefined,
      });
      expect(res.name).toBe("my-app-example-com");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("closes the gateway even if waitForLogin throws (no leaked browser)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-cap-"));
    try {
      const rec: Rec = { observed: [], saved: 0, closed: 0 };
      await expect(
        captureSession({
          url: "https://app.test/login",
          dir,
          gateway: fakeGateway(rec),
          waitForLogin: async () => {
            throw new Error("user aborted");
          },
        }),
      ).rejects.toThrow("user aborted");
      expect(rec.closed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
