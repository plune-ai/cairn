import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

/** #230: `cairn api --scenarios --save-flows <file>` saves chains as flows; `cairn api --flows <file>` writes the fixture. */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

let outChunks: string[];
let errChunks: string[];
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let dir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  outChunks = [];
  errChunks = [];
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => (outChunks.push(c.toString()), true));
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => (errChunks.push(c.toString()), true));
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no request may be sent"));
  process.exitCode = 0;
  dir = await mkdtemp(join(tmpdir(), "cairn-flows-"));
});
afterEach(async () => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  fetchSpy.mockRestore();
  process.exitCode = 0;
  vi.resetModules();
  await rm(dir, { recursive: true, force: true });
});

const cairn = async (...args: string[]): Promise<void> => {
  const { buildProgram } = await import("../../src/cli/index.js");
  await buildProgram().parseAsync(["node", "cairn", "api", ...args]);
};

const signinFlow = {
  name: "signedIn",
  kind: "signin",
  steps: [{ method: "POST", path: "/api/login", form: { user: "{{env.APP_USER}}", password: "{{env.APP_PASSWORD}}" } }],
};

describe("cairn api --save-flows (#230)", () => {
  it("saves each scenario chain that deletes what it creates, keeping the flows already in the file", async () => {
    const file = join(dir, "flows.json");
    await writeFile(file, JSON.stringify({ version: 1, flows: [signinFlow] }), "utf8");
    await cairn("--spec", join(fixtures, "crud-store.yaml"), "--scenarios", "--save-flows", file);
    const saved = JSON.parse(await readFile(file, "utf8")) as { flows: { name: string }[] };
    expect(saved.flows.map((f) => f.name)).toEqual(["signedIn", "items", "widgets"]);
    expect(outChunks.join("")).toContain(`✓ Saved 2 API flow(s) to ${file}: items, widgets`);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("needs --scenarios", async () => {
    await expect(cairn("--spec", join(fixtures, "crud-store.yaml"), "--save-flows", join(dir, "f.json"))).rejects.toThrow(
      /--save-flows saves the chains --scenarios makes/,
    );
  });
});

describe("cairn api --flows (#230)", () => {
  const writeFlows = async (): Promise<string> => {
    const file = join(dir, "flows.json");
    await cairn("--spec", join(fixtures, "crud-store.yaml"), "--scenarios", "--save-flows", file);
    outChunks.length = 0;
    return file;
  };

  it("writes the fixture without sending a request; a flow that changes data is allowed against no address", async () => {
    const file = await writeFlows();
    await cairn("--flows", file, "--out", dir);
    const ts = await readFile(join(dir, "api-flows.fixture.ts"), "utf8");
    expect(ts).toContain("export const test = base.extend<");
    expect(ts).toContain("const MUTATIONS_ALLOWED_FOR: string[] = [];");
    const out = outChunks.join("");
    expect(out).toContain("items (creates data; returns id; its cleanup deletes it afterwards)");
    expect(out).toContain("⚠ items, widgets change data: their tests are skipped until an address is allowed");
    expect(out).toContain(`✓ Fixture → ${join(dir, "api-flows.fixture.ts")}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with --base-url and --allow-mutations, allows that address only", async () => {
    const file = await writeFlows();
    await cairn("--flows", file, "--out", dir, "--base-url", "http://127.0.0.1:4000/v1", "--allow-mutations");
    const ts = await readFile(join(dir, "api-flows.fixture.ts"), "utf8");
    expect(ts).toContain('const MUTATIONS_ALLOWED_FOR: string[] = ["http://127.0.0.1:4000"];');
    expect(ts).toContain('const DEFAULT_BASE_URL: string | undefined = "http://127.0.0.1:4000/v1";');
    expect(outChunks.join("")).toContain("Flows that change data may run against http://127.0.0.1:4000");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses --spec beside --flows, and reports a bad flow file without a stack (exit 1)", async () => {
    const file = await writeFlows();
    await expect(cairn("--flows", file, "--spec", join(fixtures, "crud-store.yaml"))).rejects.toThrow(/--flows .* without --spec/);
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ version: 1, flows: [{ name: "x", steps: [{ method: "POST", path: "/x" }] }] }), "utf8");
    await cairn("--flows", bad, "--out", dir);
    expect(errChunks.join("")).toContain('"x" changes data but has no cleanup');
    expect(process.exitCode).toBe(1);
  });
});
