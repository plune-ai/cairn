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

  it("appends traceability AFTER existing rows (valid table) when a section already exists", async () => {
    const tc = join(dir, "testcases");
    const withTrace = `---\nid: MTC-DEMO-002\ntitle: "x"\nexecution: manual\nstatus: 📋 Manual\nautomation: —\n---\n\n# MTC-DEMO-002: x\n\n## Steps\n\n1. do\n\n## Expected Result\n\n- ok\n\n## Traceability\n\n| Source | Reference |\n| --- | --- |\n| Checklist | plan |\n`;
    await writeFile(join(tc, "MTC-DEMO-002.md"), withTrace);
    const res = await promoteCase(dir, "MTC-DEMO-002");
    const md = await readFile(join(tc, res.newId + ".md"), "utf8");
    // header + separator + original row must precede the new row
    const trace = md.slice(md.indexOf("## Traceability"));
    const headerIdx = trace.indexOf("| Source | Reference |");
    const sepIdx = trace.indexOf("| --- | --- |");
    const origIdx = trace.indexOf("| Checklist | plan |");
    const newIdx = trace.indexOf("| Promoted from | MTC-DEMO-002 |");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(sepIdx).toBeGreaterThan(headerIdx);
    expect(origIdx).toBeGreaterThan(sepIdx);
    expect(newIdx).toBeGreaterThan(origIdx); // new row is LAST, table stays valid
  });

  it("updates the body H1 heading to the new id", async () => {
    const res = await promoteCase(dir, "MTC-DEMO-001");
    const md = await readFile(join(dir, "testcases", res.newId + ".md"), "utf8");
    expect(md).toMatch(new RegExp(`^#\\s+${res.newId}:`, "m"));
    expect(md).not.toContain("# MTC-DEMO-001:");
  });

  it("handles a dashed suite name (LOGIN-UI)", async () => {
    const tc = join(dir, "testcases");
    await writeFile(join(tc, "MTC-LOGIN-UI-001.md"), "---\nid: MTC-LOGIN-UI-001\ntitle: \"y\"\nexecution: manual\n---\n\n# MTC-LOGIN-UI-001: y\n");
    const res = await promoteCase(dir, "MTC-LOGIN-UI-001");
    expect(res.newId).toMatch(/^ATC-LOGIN-UI-\d{3}$/);
  });

  it("does not refill selectors when the case already has a ## Selectors section", async () => {
    const tc = join(dir, "testcases");
    const withSel = `---\nid: MTC-DEMO-003\ntitle: "z"\nexecution: manual\n---\n\n# MTC-DEMO-003: z\n\n## Selectors\n\n| Element | Locator |\n| --- | --- |\n| Submit | \`page.getByRole('button')\` |\n`;
    await writeFile(join(tc, "MTC-DEMO-003.md"), withSel);
    const res = await promoteCase(dir, "MTC-DEMO-003");
    expect(res.selectorsFilled).toBe(0); // parsed selectors non-empty → skip refill
  });
});
