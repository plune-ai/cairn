#!/usr/bin/env node
/**
 * Packaged-install smoke test (`npm run smoke:pack`).
 *
 * Source tests (vitest) run against ./src and miss PACKAGING bugs: a file left out of the `files`
 * whitelist, a wrong `bin` path, an export that doesn't resolve once installed. This script proves
 * the published artifact actually works: it builds → `npm pack`s → installs the tarball into a fresh
 * temp project (no link, no source) → runs the CLI from node_modules and exercises real, HERMETIC
 * actions (no API keys, no browser, no network beyond `npm install`).
 *
 * Hermetic command coverage: --version · --help · doctor · a gated stub · session ls, plus two real
 * artifact actions on crafted fixtures — `dataset-add` (reads study.json → dataset) and `promote`
 * (deterministic MTC→ATC .md rewrite). Browser/LLM commands (explore/design/observe) need a real
 * browser + keys + a page and are intentionally OUT of scope here.
 *
 * Not part of `npm test` (pack+install is slow and pulls the full dep tree). Run it before publishing.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expectedVersion = pkg.version;

/** Run npm (via shell so npm.cmd resolves on Windows). Throws with output on a non-zero exit. */
function npm(args, opts = {}) {
  const r = spawnSync("npm", args, { encoding: "utf8", shell: true, ...opts });
  if (r.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed (${r.status})\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  }
  return r;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : detail ? ` — ${detail}` : ""}`);
}

const work = mkdtempSync(join(tmpdir(), "cairn-smoke-"));
const appDir = join(work, "app");

try {
  // 1. Build → the tarball only ships `dist/` (files whitelist) and there is no prepack hook.
  console.log("▸ building (tsc)…");
  npm(["run", "build"], { cwd: root });

  // 2. Pack the local package into the temp dir.
  console.log("▸ npm pack…");
  const packed = npm(["pack", "--json", "--pack-destination", work], { cwd: root });
  let tarball;
  try {
    tarball = join(work, JSON.parse(packed.stdout)[0].filename);
  } catch {
    tarball = join(work, `plune-ai-cairn-${expectedVersion}.tgz`); // @scope/name → scope-name-version
  }
  if (!existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`);

  // 3. Install the tarball into a fresh project. --ignore-scripts skips Playwright's chromium
  //    download (hermetic CLI commands don't need a browser); --prefer-offline uses the npm cache.
  console.log("▸ installing the tarball into a fresh project…");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "cairn-smoke-app", private: true, version: "0.0.0" }, null, 2));
  copyFileSync(tarball, join(appDir, "cairn-pkg.tgz"));
  npm(["install", "cairn-pkg.tgz", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: appDir });

  // 4. The bin path declared in package.json must exist in the installed package.
  const cliPath = join(appDir, "node_modules", "@plune-ai", "cairn", "dist", "cli", "index.js");
  check("installed package exposes its bin (dist/cli/index.js)", existsSync(cliPath), cliPath);
  if (!existsSync(cliPath)) throw new Error("CLI entry missing from the installed package — cannot run commands.");

  /**
   * Run the INSTALLED cairn CLI via node (no shell needed — node binary + arg array).
   * A DUMMY ANTHROPIC_API_KEY satisfies loadConfig's profile gate (some commands — e.g. `promote`
   * without --session — load config but never make an LLM call, so the key is never used). This
   * keeps the smoke hermetic (no real network/LLM) while letting those commands run.
   */
  const cairn = (args, opts = {}) => {
    const r = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: appDir,
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-smoke-unused", LLM_PROFILE: "anthropic" },
      ...opts,
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  console.log("▸ running hermetic CLI commands…");

  const v = cairn(["--version"]);
  check(`--version prints ${expectedVersion}`, v.status === 0 && v.out.includes(expectedVersion), v.out.trim());

  const h = cairn(["--help"]);
  check("--help lists the core commands", h.status === 0 && /design/.test(h.out) && /explore/.test(h.out) && /automate/.test(h.out));

  const doctor = cairn(["doctor"]);
  check("doctor exits 0", doctor.status === 0, `status ${doctor.status}`);

  const gated = cairn(["ui"]);
  check("gated stub (ui) prints coming-soon and exits 0", gated.status === 0 && /coming soon/i.test(gated.out));

  mkdirSync(join(appDir, ".auth"), { recursive: true }); // empty sessions dir → deterministic "none"
  const sess = cairn(["session", "ls"]);
  check("session ls works with no saved sessions", sess.status === 0 && /No saved sessions/.test(sess.out), sess.out.trim());

  // 5. Real, hermetic artifact actions on a crafted run dir (no LLM / no browser).
  console.log("▸ running real artifact actions on fixtures…");
  const runFix = join(appDir, "fixture-run");
  const tcDir = join(runFix, "testcases");
  mkdirSync(tcDir, { recursive: true });
  writeFileSync(
    join(runFix, "study.json"),
    JSON.stringify({ url: "https://smoke.test/page", elements: [{ ref: "e49", role: "button", name: "Submit", interactive: true, rank: 9 }] }),
  );
  writeFileSync(
    join(runFix, "report.json"),
    JSON.stringify({
      url: "https://smoke.test/page",
      pageSemantics: "A smoke-test page",
      testCases: [{ id: "tc-9", title: "Submit empty form shows errors", elementRefs: ["e49"] }],
    }),
  );
  writeFileSync(join(tcDir, "ATC-DEMO-001.md"), "---\nid: ATC-DEMO-001\n---\n# x\n");
  writeFileSync(join(tcDir, "ATC-DEMO-002.md"), "---\nid: ATC-DEMO-002\n---\n# x\n");
  writeFileSync(
    join(tcDir, "MTC-DEMO-001.md"),
    `---\nid: MTC-DEMO-001\ntitle: "Submit empty form shows errors"\nsuite: DEMO\npriority: P1\ntype: Negative\nexecution: manual\nstatus: 📋 Manual\nautomation: — (manual, not automated)\n---\n\n# MTC-DEMO-001: Submit empty form shows errors\n\n## Preconditions\n\n- The form is open\n\n## Steps\n\n1. Click Submit without filling fields\n\n## Expected Result\n\n- Validation errors are shown\n`,
  );

  const dsFile = join(appDir, "dataset.json");
  const da = cairn(["dataset-add", "--from-run", runFix, "--to", dsFile]);
  let dsOk = false;
  try {
    const ds = JSON.parse(readFileSync(dsFile, "utf8"));
    dsOk = da.status === 0 && Array.isArray(ds.items) && ds.items.length === 1 && ds.items[0].pageSemantics === "A smoke-test page";
  } catch {
    dsOk = false;
  }
  check("dataset-add reads the run and writes a dataset item", dsOk, da.out.trim());

  const pr = cairn(["promote", "--run", runFix, "--cases", "MTC-DEMO-001"]);
  const tcAfter = existsSync(tcDir) ? readdirSync(tcDir) : [];
  const promoteOk =
    pr.status === 0 &&
    tcAfter.includes("ATC-DEMO-003.md") && // 001/002 taken → next free is 003
    !tcAfter.includes("MTC-DEMO-001.md"); // promoted in place
  check("promote rewrites MTC-DEMO-001 → ATC-DEMO-003 (.md transform)", promoteOk, pr.out.trim());

  // 6. Verdict.
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "✓ smoke passed" : `✗ smoke FAILED (${failed.length}/${results.length})`} — ${results.length} checks`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error(`\n✗ smoke errored: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  // Always clean up the temp project (best-effort; Windows can hold file locks briefly).
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.error(`(note: could not remove temp dir ${work})`);
  }
}
