import { describe, it, expect, vi } from "vitest";
import { parseInputs, buildContext } from "../../src/ci/inputs.js";
import { selectCommentAction, withMarker, RestGitHubClient, COMMENT_MARKER } from "../../src/ci/github.js";
import { renderCiSummary } from "../../src/ci/summary.js";
import { runCi, matchesAnyGlob, type CiDeps } from "../../src/ci/run.js";
import type { ExploreResult, DesignResult } from "../../src/agent/index.js";

type Env = Record<string, string | undefined>;

// ── inputs ───────────────────────────────────────────────────────────────────
describe("CI inputs (#50)", () => {
  const base: Env = { INPUT_URL: "https://x" };

  it("parses valid inputs with sensible defaults", () => {
    const i = parseInputs(base);
    expect(i.url).toBe("https://x");
    expect(i.mode).toBe("explore");
    expect(i.intoProject).toBe(true); // project-fit on by default
    expect(i.comment).toBe(true);
    expect(i.openPr).toBe(false); // follow-up PR opt-in
    expect(i.prBranch).toBe("cairn/update-tests");
  });

  it("missing url → clean error", () => {
    expect(() => parseInputs({})).toThrow(/Required input "url"/);
  });

  it("rejects a bad boolean and a bad mode", () => {
    expect(() => parseInputs({ ...base, "INPUT_OPEN-PR": "yes" })).toThrow(/must be "true" or "false"/);
    expect(() => parseInputs({ ...base, INPUT_MODE: "fuzz" })).toThrow(/must be "explore" or "design"/);
  });

  it("parses passthrough flags + multiline paths", () => {
    const i = parseInputs({
      ...base,
      INPUT_MODE: "design",
      INPUT_ROUTING: "volume",
      "INPUT_INTO-PROJECT": "false",
      INPUT_PATHS: "src/a/**\n  src/b/*  ,src/c.ts",
    });
    expect(i.mode).toBe("design");
    expect(i.routing).toBe("volume");
    expect(i.intoProject).toBe(false);
    expect(i.paths).toEqual(["src/a/**", "src/b/*", "src/c.ts"]);
  });

  it("buildContext reads repo/PR/token and detects forks", () => {
    const env: Env = { GITHUB_REPOSITORY: "plune-ai/cairn", GITHUB_TOKEN: "tok" };
    const ctx = buildContext(env, {
      pull_request: {
        number: 7,
        head: { ref: "feat", repo: { full_name: "contributor/cairn" } },
        base: { ref: "main", repo: { full_name: "plune-ai/cairn" } },
      },
    });
    expect(ctx.owner).toBe("plune-ai");
    expect(ctx.repo).toBe("cairn");
    expect(ctx.prNumber).toBe(7);
    expect(ctx.token).toBe("tok");
    expect(ctx.isFork).toBe(true);
  });
});

// ── comment idempotency + summary ──────────────────────────────────────────────
describe("CI comment + summary (#50)", () => {
  it("selectCommentAction updates the marked comment, else creates", () => {
    expect(selectCommentAction([])).toEqual({ action: "created" });
    expect(selectCommentAction([{ id: 3, body: "hi" }])).toEqual({ action: "created" });
    expect(selectCommentAction([{ id: 9, body: withMarker("prev") }])).toEqual({ action: "updated", id: 9 });
  });

  it("renderCiSummary renders metrics for explore + a no-op note", () => {
    const body = renderCiSummary({
      mode: "explore",
      url: "https://x",
      caseCount: 4,
      specCount: 2,
      validation: { greenRatio: 1, passed: 3, failed: 0, flaky: 0 },
      pilot: { verdict: "pass", reason: "looks good" },
      cost: { totalTokens: 1234, totalCostUsd: 0.0123 },
      followupPr: { url: "https://pr/7", number: 7 },
    });
    expect(body).toContain("Test cases:** 4");
    expect(body).toContain("Spec files:** 2");
    expect(body).toContain("100% green");
    expect(body).toContain("Pilot verdict:** pass");
    expect(body).toContain("$0.0123");
    expect(body).toContain("follow-up PR");

    const noop = renderCiSummary({ mode: "explore", url: "https://x", caseCount: 0, specCount: 0, noOpReason: "no changed surfaces matched the configured `paths`" });
    expect(noop).toContain("No tests generated");
  });

  it("globs gate changed files", () => {
    expect(matchesAnyGlob("src/app/login/page.tsx", ["src/app/login/**"])).toBe(true);
    expect(matchesAnyGlob("src/other.ts", ["src/app/login/**"])).toBe(false);
    expect(matchesAnyGlob("a/b/c.ts", ["**/*.ts"])).toBe(true);
  });
});

// ── REST client idempotency (mocked fetch, no network) ─────────────────────────
describe("RestGitHubClient.upsertComment (#50)", () => {
  function okJson(data: unknown) {
    return { ok: true, status: 200, statusText: "OK", json: async () => data, text: async () => "" } as Response;
  }

  it("PATCHes the existing marked comment instead of posting a duplicate", async () => {
    const calls: { method?: string; url: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ method: init?.method, url: u });
      if (init?.method === "GET") return okJson([{ id: 42, body: `${COMMENT_MARKER}\nold` }]);
      return okJson({ id: 42 });
    });
    const client = new RestGitHubClient(
      { owner: "o", repo: "r", apiUrl: "https://api.github.com", token: "tok", isFork: false },
      fetchImpl as unknown as typeof fetch,
    );
    const r = await client.upsertComment(7, "new body");
    expect(r).toEqual({ action: "updated", id: 42 });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/issues/comments/42"))).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("POSTs a new comment when none is marked", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") return okJson([{ id: 1, body: "unrelated" }]);
      return okJson({ id: 99 });
    });
    const client = new RestGitHubClient(
      { owner: "o", repo: "r", apiUrl: "https://api.github.com", token: "tok", isFork: false },
      fetchImpl as unknown as typeof fetch,
    );
    const r = await client.upsertComment(7, "new body");
    expect(r).toEqual({ action: "created", id: 99 });
  });
});

// ── orchestrator ───────────────────────────────────────────────────────────────
const exploreResult = {
  runId: "r1",
  runDir: "runs/r1",
  testCases: [{ id: "tc-1" }, { id: "tc-2" }],
  suite: { files: [{ path: "login.spec.ts", content: "x" }] },
  projectSpecFiles: ["/work/e2e/login.spec.ts"],
  projectTestDir: "/work/e2e",
  validation: { greenRatio: 1, flakyCount: 0, results: [{ status: "passed" }] },
  pilot: { verdict: "pass", reason: "ok", guidance: "" },
  cost: { totalTokens: 100, totalCostUsd: 0.01 },
} as unknown as ExploreResult;

const designResult = {
  runId: "d1",
  runDir: "runs/d1",
  testCases: [{ id: "tc-1" }],
  cost: { totalTokens: 50, totalCostUsd: 0.005 },
} as unknown as DesignResult;

function makeDeps(over: Partial<CiDeps> = {}) {
  const calls: { config?: unknown; explore?: unknown; design?: unknown } = {};
  const github = {
    listChangedFiles: vi.fn(async () => [{ filename: "src/app/login/page.tsx", status: "modified" }]),
    upsertComment: vi.fn(async () => ({ action: "created" as const, id: 1 })),
    openFollowupPr: vi.fn(async () => ({ url: "https://pr/7", number: 7 })),
  };
  const deps: CiDeps = {
    resolveConfig: vi.fn((flags) => {
      calls.config = flags;
      return {} as unknown as ReturnType<CiDeps["resolveConfig"]>;
    }),
    runExploration: vi.fn(async (input) => {
      calls.explore = input;
      return exploreResult;
    }),
    runDesign: vi.fn(async (input) => {
      calls.design = input;
      return designResult;
    }),
    makeGitHubClient: () => github,
    readInputFile: vi.fn(async () => "checklist text"),
    resolveStyleText: vi.fn(async () => "style text"),
    readFile: vi.fn(async () => "spec content"),
    cwd: () => "/work",
    log: () => undefined,
    ...over,
  };
  return { deps, github, calls };
}

const prEvent = {
  pull_request: {
    number: 7,
    head: { ref: "feat", repo: { full_name: "plune-ai/cairn" } },
    base: { ref: "main", repo: { full_name: "plune-ai/cairn" } },
  },
};

function env(over: Env = {}): Env {
  return { GITHUB_REPOSITORY: "plune-ai/cairn", GITHUB_API_URL: "https://api.github.com", GITHUB_TOKEN: "tok", INPUT_URL: "https://x", ...over };
}

describe("runCi orchestrator (#50)", () => {
  it("explore: reuses resolveConfig, calls core with project-fit, posts the comment", async () => {
    const { deps, github, calls } = makeDeps();
    const r = await runCi(env({ INPUT_ROUTING: "volume" }), prEvent, deps);

    // config reused (routing flows through resolveConfig — keys are read from env there, not hardcoded)
    expect(calls.config).toEqual({ backend: undefined, routing: "volume", channel: undefined });
    expect(deps.runExploration).toHaveBeenCalledTimes(1);
    expect((calls.explore as { url: string; intoProject: boolean }).url).toBe("https://x");
    expect((calls.explore as { intoProject: boolean }).intoProject).toBe(true); // project-fit (#51)

    expect(r.ranCore).toBe(true);
    expect(r.summary.caseCount).toBe(2);
    expect(r.summary.specCount).toBe(1);
    expect(github.upsertComment).toHaveBeenCalledTimes(1);
    expect(r.comment).toEqual({ action: "created", id: 1 });
    expect(github.openFollowupPr).not.toHaveBeenCalled(); // toggle off
  });

  it("opens a follow-up PR ONLY when open-pr is on (and carries repo-relative specs)", async () => {
    const { deps, github } = makeDeps();
    const r = await runCi(env({ "INPUT_OPEN-PR": "true" }), prEvent, deps);
    expect(github.openFollowupPr).toHaveBeenCalledTimes(1);
    const arg = github.openFollowupPr.mock.calls[0][0];
    expect(arg.files).toEqual([{ path: "e2e/login.spec.ts", content: "spec content" }]);
    expect(arg.baseBranch).toBe("feat"); // branch from the PR head
    expect(arg.branch).toBe("cairn/update-tests-7");
    expect(r.followupPr).toEqual({ url: "https://pr/7", number: 7 });
  });

  it("open-pr in design mode is ignored (no code to carry)", async () => {
    const { deps, github } = makeDeps();
    const r = await runCi(env({ INPUT_MODE: "design", "INPUT_OPEN-PR": "true" }), prEvent, deps);
    expect(deps.runDesign).toHaveBeenCalledTimes(1);
    expect(github.openFollowupPr).not.toHaveBeenCalled();
    expect(r.skippedEffects.join(" ")).toMatch(/only `explore` mode produces code/);
  });

  it("changed-surface gate: no matching path → no-op, core not run", async () => {
    const { deps, github } = makeDeps({
      // PR touched only an unrelated file
    });
    github.listChangedFiles.mockResolvedValueOnce([{ filename: "README.md", status: "modified" }]);
    const r = await runCi(env({ INPUT_PATHS: "src/app/login/**" }), prEvent, deps);
    expect(r.ranCore).toBe(false);
    expect(deps.runExploration).not.toHaveBeenCalled();
    expect(r.summary.noOpReason).toMatch(/no changed surfaces/);
    expect(github.upsertComment).toHaveBeenCalledTimes(1); // no-op comment still posted
  });

  it("matching path → core runs", async () => {
    const { deps } = makeDeps();
    const r = await runCi(env({ INPUT_PATHS: "src/app/login/**" }), prEvent, deps);
    expect(r.ranCore).toBe(true);
    expect(deps.runExploration).toHaveBeenCalledTimes(1);
  });

  it("fork PR → core still runs but GitHub effects are skipped (read-only token)", async () => {
    const { deps, github } = makeDeps();
    const forkEvent = {
      pull_request: { number: 7, head: { ref: "feat", repo: { full_name: "contributor/cairn" } }, base: { ref: "main", repo: { full_name: "plune-ai/cairn" } } },
    };
    const r = await runCi(env({ "INPUT_OPEN-PR": "true" }), forkEvent, deps);
    expect(r.ranCore).toBe(true);
    expect(github.upsertComment).not.toHaveBeenCalled();
    expect(github.openFollowupPr).not.toHaveBeenCalled();
    expect(r.skippedEffects.join(" ")).toMatch(/fork PR/);
  });

  it("no token → effects skipped, no client built, core still runs", async () => {
    const made = makeDeps();
    const r = await runCi(env({ GITHUB_TOKEN: undefined }), prEvent, made.deps);
    expect(r.ranCore).toBe(true);
    expect(made.github.upsertComment).not.toHaveBeenCalled();
    expect(r.skippedEffects.join(" ")).toMatch(/no github-token/);
  });
});
