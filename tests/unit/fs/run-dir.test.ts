import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveRunDir,
  defaultRunsBaseDir,
  runDirNotFoundMessage,
  readInputFile,
} from "../../../src/fs/run-dir.js";

const UUID = "2ecb594f-021d-4077-b341-f1bd8ae25a0d";

describe("resolveRunDir", () => {
  let parent: string; // temp parent so the runs base dir is literally named "runs"
  let base: string; // <parent>/runs  (basename === "runs", as in production)
  let runDir: string; // <base>/<UUID>
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "cairn-resolve-"));
    base = join(parent, "runs");
    runDir = join(base, UUID);
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("(a) returns an existing absolute path verbatim", async () => {
    expect(await resolveRunDir(runDir, { runsBaseDir: base })).toBe(resolve(runDir));
  });

  it("(b) resolves a bare run id under the runs base dir", async () => {
    expect(await resolveRunDir(UUID, { runsBaseDir: base })).toBe(resolve(base, UUID));
  });

  it("(c) recovers the Git-Bash glued `runs<id>` case (eaten separator)", async () => {
    // This is the exact regression: `--run runs\<id>` arrives as `runs<id>` after the shell eats `\`.
    expect(await resolveRunDir(`runs${UUID}`, { runsBaseDir: base })).toBe(resolve(base, UUID));
  });

  it("(a) takes precedence over glued recovery when the literal path exists", async () => {
    const value = `runs${UUID}`;
    const literal = resolve(value);
    // isDir says the literal `runs<id>` dir exists in cwd → (a) must win, no stripping.
    const isDir = async (p: string): Promise<boolean> => p === literal;
    expect(await resolveRunDir(value, { runsBaseDir: base, isDir })).toBe(literal);
  });

  it("(d) throws an actionable error when nothing matches", async () => {
    await expect(resolveRunDir("nope-no-such-run", { runsBaseDir: base })).rejects.toThrow(
      /Run directory not found/,
    );
  });

  it("does not silently map a non-existent ABSOLUTE path to a same-named run (isAbsolute guard)", async () => {
    // base/<UUID> exists, but this different absolute path ending in <UUID> does NOT — must throw, not map.
    const otherAbs = resolve(parent, "not-the-base", UUID);
    await expect(resolveRunDir(otherAbs, { runsBaseDir: base })).rejects.toThrow(/not found/i);
  });
});

describe("defaultRunsBaseDir", () => {
  it("is <cwd>/runs", () => {
    expect(defaultRunsBaseDir()).toBe(resolve(process.cwd(), "runs"));
  });
});

describe("runDirNotFoundMessage", () => {
  it("lists available runs and carries the bare-id + Git-Bash tips", () => {
    const msg = runDirNotFoundMessage(`runs${UUID}`, "/proj/runs", [UUID, "9af10000-0000-0000-0000-000000000000"]);
    expect(msg).toMatch(/not found/i);
    expect(msg).toContain(UUID); // available list
    expect(msg).toMatch(/--run <id>|bare|run id/i); // bare-id tip
    expect(msg).toMatch(/Git Bash|forward slash|quote/i); // shell-trap tip
    // The path it tried is shown POSIX-style (the literal `\` in the human tip is intentional).
    const triedLine = msg.split("\n").find((l) => l.includes("Tried:")) ?? "";
    expect(triedLine).not.toContain("\\");
  });

  it("degrades gracefully when there are no runs yet", () => {
    const msg = runDirNotFoundMessage("x", "/proj/runs", []);
    expect(msg).toMatch(/none yet|no runs/i);
  });
});

describe("readInputFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cairn-input-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the file contents when present", async () => {
    const f = join(dir, "checklist.md");
    await writeFile(f, "- test the thing\n");
    expect(await readInputFile(f, "Checklist")).toBe("- test the thing\n");
  });

  it("throws a friendly error (label + Git-Bash tip) when the file is missing", async () => {
    const missing = join(dir, "nope.md");
    await expect(readInputFile(missing, "Checklist")).rejects.toThrow(/Checklist not found/);
    await expect(readInputFile(missing, "Checklist")).rejects.toThrow(/Git Bash|forward slash|quote/i);
  });
});
