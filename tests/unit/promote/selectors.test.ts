import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSelectors } from "../../../src/promote/selectors.js";

describe("collectSelectors", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promote-sel-"));
    await writeFile(
      join(dir, "study.json"),
      JSON.stringify({
        url: "https://x",
        elements: [
          { ref: "e45", role: "textbox", name: "Full Name", interactive: true, rank: 5 },
          { ref: "e49", role: "button", name: "Submit", interactive: true, rank: 9 },
        ],
      }),
    );
    await writeFile(join(dir, "report.json"), JSON.stringify({ url: "https://x" }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fills selectors from study elements (offline)", async () => {
    const { selectors, missing } = await collectSelectors(dir, ["e45", "e49"]);
    expect(missing).toEqual([]);
    expect(selectors).toContainEqual({
      label: "Full Name",
      locator: "page.getByRole('textbox', { name: 'Full Name' })",
    });
    expect(selectors).toContainEqual({
      label: "Submit",
      locator: "page.getByRole('button', { name: 'Submit' })",
    });
  });

  it("reports refs missing from study when no live fallback", async () => {
    const { selectors, missing } = await collectSelectors(dir, ["e45", "e99"]);
    expect(selectors).toHaveLength(1);
    expect(missing).toEqual(["e99"]);
  });

  it("uses the live fallback (with report.json url) for missing refs", async () => {
    const collectLive = async (url: string, refs: string[]): Promise<Map<string, string>> => {
      expect(url).toBe("https://x");
      return new Map(refs.map((r) => [r, `page.getByRole('link') /* ${r} */`]));
    };
    const { selectors, missing } = await collectSelectors(dir, ["e99"], { collectLive });
    expect(missing).toEqual([]);
    expect(selectors[0]?.locator).toContain("getByRole('link')");
  });

  it("treats all refs as missing when study.json is absent", async () => {
    await rm(join(dir, "study.json"), { force: true });
    const { selectors, missing } = await collectSelectors(dir, ["e45"]);
    expect(selectors).toHaveLength(0);
    expect(missing).toEqual(["e45"]);
  });

  it("skips the live fallback when report.json has no url", async () => {
    await rm(join(dir, "report.json"), { force: true });
    const calls: string[][] = [];
    const collectLive = async (_url: string, refs: string[]): Promise<Map<string, string>> => {
      calls.push(refs);
      return new Map();
    };
    const { missing } = await collectSelectors(dir, ["e99"], { collectLive });
    expect(calls).toHaveLength(0); // collectLive must NOT be called without a url
    expect(missing).toEqual(["e99"]);
  });
});
