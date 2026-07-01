import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAutomate } from "../../src/agent/index.js";
import { loadConfig } from "../../src/config/index.js";
import { renderApiTestCaseMd, type ApiTestCaseDoc } from "../../src/artifacts/testcase-md.js";
import type { ApiCase } from "../../src/api/cases.js";

/**
 * C1-04 / API-7 (#144): `cairn automate --run <runDir>` on an API run (report.json's `mode: "api"`,
 * API-4) — the decoupled contract web runs already have, now covering API ATC cases too.
 */
const apiCase: ApiCase = {
  name: "getPet",
  method: "GET",
  path: "/pets/{id}",
  params: { path: { id: "1" }, query: {}, header: {}, cookie: {} },
  expectedStatus: "200",
  technique: "equivalence-partitioning",
  rationale: "Happy-path case in the valid equivalence class for GET /pets/{id}: asserts 200.",
};
const apiDoc: ApiTestCaseDoc = { id: "ATC-PETSTORE-API-001", suite: "PETSTORE-API", status: "❌ Not run" };

describe("runAutomate — API runs (API-7, #144)", () => {
  it("generates tests/api.spec.ts from ATC cases with no LLM call and no validation", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "qa-automate-api-"));
    try {
      await writeFile(
        join(runDir, "report.json"),
        JSON.stringify({ runId: "api-1", url: "https://api.test", mode: "api" }),
        "utf8",
      );
      const tcDir = join(runDir, "testcases");
      await mkdir(tcDir, { recursive: true });
      await writeFile(join(tcDir, `${apiDoc.id}.md`), renderApiTestCaseMd(apiCase, apiDoc), "utf8");

      const config = loadConfig({ ANTHROPIC_API_KEY: "test-key" });
      const result = await runAutomate({ runDir, config });

      expect(result.specFiles).toHaveLength(1);
      expect(result.validation).toBeUndefined();
      const content = await readFile(join(runDir, "tests", "api.spec.ts"), "utf8");
      expect(content).toContain("@playwright/test");
      expect(content).toContain("request.fetch");
      expect(content).toContain("${baseURL}/pets/1");
      expect(content).toContain("expect(response.status()).toBe(200);");
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("--validate on an API run is a no-op (web-only), still writes the suite", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "qa-automate-api-"));
    try {
      await writeFile(
        join(runDir, "report.json"),
        JSON.stringify({ runId: "api-1", url: "https://api.test", mode: "api" }),
        "utf8",
      );
      const tcDir = join(runDir, "testcases");
      await mkdir(tcDir, { recursive: true });
      await writeFile(join(tcDir, `${apiDoc.id}.md`), renderApiTestCaseMd(apiCase, apiDoc), "utf8");

      const config = loadConfig({ ANTHROPIC_API_KEY: "test-key" });
      const events: string[] = [];
      const result = await runAutomate({ runDir, config, validate: true, onProgress: (e) => events.push(e) });

      expect(result.validation).toBeUndefined();
      expect(result.specFiles).toHaveLength(1);
      expect(events.some((e) => e.includes("--validate needs a browser/session"))).toBe(true);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
