import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteCase } from "../../../src/promote/promote-case.js";

const MTC = `---
id: MTC-DEMO-001
title: "Submit empty form shows errors"
suite: DEMO
priority: P1
type: Negative
execution: manual
status: 📋 Manual
automation: — (manual, not automated)
---

# MTC-DEMO-001: Submit empty form shows errors

## Preconditions

- The form is open

## Steps

1. Click Submit without filling fields

## Expected Result

- Validation errors are shown
`;

describe("promoteCase", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "promote-case-"));
    const tc = join(dir, "testcases");
    await mkdir(tc, { recursive: true });
    await writeFile(join(tc, "ATC-DEMO-001.md"), "---\nid: ATC-DEMO-001\n---\n# x\n");
    await writeFile(join(tc, "ATC-DEMO-002.md"), "---\nid: ATC-DEMO-002\n---\n# x\n");
    await writeFile(join(tc, "MTC-DEMO-001.md"), MTC);
    await writeFile(
      join(dir, "report.json"),
      JSON.stringify({
        url: "https://x",
        testCases: [
          { id: "tc-9", title: "Submit empty form shows errors", elementRefs: ["e49"] },
        ],
      }),
    );
    await writeFile(
      join(dir, "study.json"),
      JSON.stringify({
        url: "https://x",
        elements: [{ ref: "e49", role: "button", name: "Submit", interactive: true, rank: 9 }],
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renames MTC→next free ATC number and rewrites frontmatter", async () => {
    const res = await promoteCase(dir, "MTC-DEMO-001");
    expect(res.oldId).toBe("MTC-DEMO-001");
    expect(res.newId).toBe("ATC-DEMO-003"); // 001/002 exist → 003

    const files = await readdir(join(dir, "testcases"));
    expect(files).toContain("ATC-DEMO-003.md");
    expect(files).not.toContain("MTC-DEMO-001.md"); // in-place: original gone

    const md = await readFile(join(dir, "testcases", "ATC-DEMO-003.md"), "utf8");
    expect(md).toMatch(/^id:\s*ATC-DEMO-003$/m);
    expect(md).toMatch(/^execution:\s*auto$/m);
    expect(md).toMatch(/^automation:\s*tests\/ui\/demo\/atc-demo-003\.spec\.ts$/m);
    expect(md).toContain("Promoted from"); // traceability trail
    expect(md).toContain("MTC-DEMO-001");
  });

  it("refills selectors from study (matched by title) when the .md had none", async () => {
    const res = await promoteCase(dir, "MTC-DEMO-001");
    expect(res.selectorsFilled).toBe(1);
    const md = await readFile(join(dir, "testcases", res.newId + ".md"), "utf8");
    expect(md).toContain("## Selectors");
    expect(md).toContain("page.getByRole('button', { name: 'Submit' })");
  });

  it("rejects a non-MTC id", async () => {
    await expect(promoteCase(dir, "ATC-DEMO-001")).rejects.toThrow(/only MTC/);
  });
});
