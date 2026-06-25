import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findPlaywrightConfig,
  parseConfigConventions,
  resolveProjectTarget,
  isSpecFile,
  planPlacement,
  ejectSuiteToProject,
} from "../../src/project/index.js";
import type { FileBlob } from "../../src/codegen/index.js";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("project detection (#51)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cairn-proj-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("findPlaywrightConfig walks up to the nearest config (any supported extension)", async () => {
    await writeFile(join(root, "playwright.config.ts"), "export default {}");
    const nested = join(root, "packages", "web", "src");
    await mkdir(nested, { recursive: true });
    expect(await findPlaywrightConfig(nested)).toBe(join(root, "playwright.config.ts"));
  });

  it("findPlaywrightConfig returns undefined when no config exists anywhere up to root", async () => {
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    expect(await findPlaywrightConfig(nested)).toBeUndefined();
  });

  it("parseConfigConventions resolves a custom testDir relative to the config dir", () => {
    const { testDir, specSuffix } = parseConfigConventions(`export default { testDir: './e2e' }`, root);
    expect(testDir).toBe(resolve(root, "e2e"));
    expect(specSuffix).toBe(".spec.ts"); // no testMatch → conventional default
  });

  it("parseConfigConventions falls back to the config dir when testDir is absent (Playwright default)", () => {
    const { testDir } = parseConfigConventions(`export default defineConfig({ retries: 1 })`, root);
    expect(testDir).toBe(resolve(root));
  });

  it("parseConfigConventions derives a .test.ts suffix when testMatch targets .test. and not .spec.", () => {
    const cfg = `export default { testMatch: '**/*.test.ts' }`;
    expect(parseConfigConventions(cfg, root).specSuffix).toBe(".test.ts");
  });

  it("parseConfigConventions keeps .spec.ts when testMatch mentions spec (conservative)", () => {
    const cfg = `export default { testMatch: /.*\\.(spec|test)\\.ts/ }`;
    expect(parseConfigConventions(cfg, root).specSuffix).toBe(".spec.ts");
  });

  it("resolveProjectTarget: config present → testDir + configPath", async () => {
    await writeFile(join(root, "playwright.config.ts"), `export default { testDir: './tests' }`);
    const t = await resolveProjectTarget({ cwd: root });
    expect(t?.testDir).toBe(resolve(root, "tests"));
    expect(t?.configPath).toBe(join(root, "playwright.config.ts"));
  });

  it("resolveProjectTarget: explicit dir without a config → that dir IS the testDir (honor the request)", async () => {
    const t = await resolveProjectTarget({ dir: join(root, "e2e") });
    expect(t?.testDir).toBe(resolve(root, "e2e"));
    expect(t?.configPath).toBeUndefined();
  });

  it("resolveProjectTarget: no config and no explicit dir → undefined (greenfield fallback)", async () => {
    expect(await resolveProjectTarget({ cwd: root })).toBeUndefined();
  });
});

describe("placement planning (#51 — pure, collision-safe)", () => {
  const blob = (path: string): FileBlob => ({ path, content: `// ${path}` });

  it("isSpecFile distinguishes specs from POM/helpers", () => {
    expect(isSpecFile("login.spec.ts")).toBe(true);
    expect(isSpecFile("cart.test.ts")).toBe(true);
    expect(isSpecFile("pages/LoginPage.ts")).toBe(false);
  });

  it("normalizes the spec suffix to the project convention; POM files keep their name", () => {
    const plan = planPlacement([blob("login.spec.ts"), blob("pages/LoginPage.ts")], ".test.ts", () => false);
    expect(plan[0]?.rel).toBe("login.test.ts");
    expect(plan[1]?.rel).toBe("pages/LoginPage.ts"); // non-spec untouched
    expect(plan[0]?.renamedFrom).toBeUndefined(); // suffix change is not a "collision rename"
  });

  it("never collides with a pre-existing file — renames Cairn's own spec instead", () => {
    const taken = new Set(["login.spec.ts"]);
    const plan = planPlacement([blob("login.spec.ts")], ".spec.ts", (r) => taken.has(r));
    expect(plan[0]?.rel).toBe("login.cairn.spec.ts");
    expect(plan[0]?.renamedFrom).toBe("login.spec.ts");
  });

  it("dedupes within a single batch (two files normalizing to the same name)", () => {
    const plan = planPlacement([blob("a.spec.ts"), blob("a.test.ts")], ".spec.ts", () => false);
    expect(plan.map((p) => p.rel)).toEqual(["a.spec.ts", "a.cairn.spec.ts"]);
  });
});

describe("ejectSuiteToProject (#51 — writes into the project, non-destructive)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cairn-eject-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("DoD: config with custom testDir → specs land there in the project's naming; greenfield runs/ untouched", async () => {
    await writeFile(join(root, "playwright.config.ts"), `export default { testDir: './e2e', testMatch: '**/*.test.ts' }`);
    const target = await resolveProjectTarget({ cwd: root });
    expect(target).toBeDefined();
    const res = await ejectSuiteToProject(
      [{ path: "login.spec.ts", content: "// login" }, { path: "pages/LoginPage.ts", content: "// pom" }],
      target!,
    );
    // spec renamed to the project's .test.ts convention, POM preserved under its subdir
    expect(await readFile(join(root, "e2e", "login.test.ts"), "utf8")).toBe("// login");
    expect(await readFile(join(root, "e2e", "pages", "LoginPage.ts"), "utf8")).toBe("// pom");
    expect(res.written).toHaveLength(2);
    expect(await exists(join(root, "runs"))).toBe(false); // no greenfield runs/ folder created by the eject
  });

  it("does NOT overwrite a pre-existing project spec — writes a disambiguated file beside it", async () => {
    const testDir = join(root, "tests");
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "login.spec.ts"), "// HAND-WRITTEN — must survive");
    const res = await ejectSuiteToProject([{ path: "login.spec.ts", content: "// generated" }], {
      testDir,
      specSuffix: ".spec.ts",
    });
    expect(await readFile(join(testDir, "login.spec.ts"), "utf8")).toBe("// HAND-WRITTEN — must survive");
    expect(await readFile(join(testDir, "login.cairn.spec.ts"), "utf8")).toBe("// generated");
    expect(res.renamed).toEqual([{ from: "login.spec.ts", to: "login.cairn.spec.ts" }]);
    expect((await readdir(testDir)).sort()).toEqual(["login.cairn.spec.ts", "login.spec.ts"]);
  });
});
