import { describe, it, expect } from "vitest";
import { makeGateway } from "../../src/browser/index.js";

describe("makeGateway (composition, ADR-0003)", () => {
  it("backend 'lib' → returns a gateway (without launching a browser)", async () => {
    const g = makeGateway({ backend: "lib" });
    expect(g).toBeDefined();
    expect(typeof g.observe).toBe("function");
    expect(typeof g.session).toBe("function");
    await g.close();
  });

  it("backend 'cli' → returns a gateway (observe/act → cli, session/runTests → lib)", async () => {
    const g = makeGateway({ backend: "cli" });
    expect(g).toBeDefined();
    expect(typeof g.observe).toBe("function");
    await g.close();
  });
});
