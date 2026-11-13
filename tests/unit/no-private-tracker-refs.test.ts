// This repository is public, so no tracked file may point at the private tracker the platform is
// developed in — CHANGELOG.md included, since GitHub and npm show it. Public repos (cli, cairn,
// eval-action, web-site) are fine.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Built from parts so this file does not match itself. `plune-ai/plune-x` (another repo) is fine.
const PRIVATE_REF = new RegExp(`plune-ai/${"plune"}(#|/|[^-a-z]|$)|\\b${"plune"}#[0-9]+`, "m");

describe("no references to the private tracker", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "");

  it("scans the tracked files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds none in any tracked file", () => {
    const hits = files.flatMap((file) =>
      readFileSync(`${ROOT}${file}`, "utf8")
        .split("\n")
        .flatMap((line, i) => (PRIVATE_REF.test(line) ? [`${file}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
