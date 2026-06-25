/**
 * INT-02 (#50) — CI / PR bot orchestrator.
 *
 * A THIN wrapper over the shared core (same pattern as the MCP layer, #49): validate inputs → reuse
 * `resolveConfig` (routing / cost / config) → call the SAME `runExploration` / `runDesign` the CLI
 * calls → compose a summary → post it as the PR comment → OPTIONALLY open a follow-up PR with the
 * generated tests. No new generation logic lives here; specs land via the #51 project-fit writer.
 *
 * Every external effect (core, GitHub API, fs, clock) is injected through {@link CiDeps}, so the whole
 * flow is unit-testable with mocks — no browser, no LLM, no network.
 */
import { join, relative, resolve } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { resolveConfig } from "../core/config.js";
import { runExploration, runDesign } from "../agent/index.js";
import type { ExploreInput, ExploreResult, DesignResult } from "../agent/index.js";
import { readInputFile } from "../fs/run-dir.js";
import { resolveStyleText } from "../design/style.js";
import { parseInputs, buildContext } from "./inputs.js";
import type { CiInputs, CiContext, PullRequestEvent } from "./inputs.js";
import { RestGitHubClient } from "./github.js";
import type { GitHubClient, CommitFile } from "./github.js";
import { renderCiSummary } from "./summary.js";
import type { CiSummary } from "./summary.js";

type Env = Record<string, string | undefined>;

/** Injected seams — every dep defaults to the real implementation; tests pass mocks. */
export interface CiDeps {
  resolveConfig: typeof resolveConfig;
  runExploration: typeof runExploration;
  runDesign: typeof runDesign;
  /** Build the GitHub client for a context (default: REST). Skipped entirely when there is no token. */
  makeGitHubClient: (ctx: CiContext) => GitHubClient;
  readInputFile: typeof readInputFile;
  resolveStyleText: typeof resolveStyleText;
  /** Read a generated spec from disk (for the follow-up PR commit). */
  readFile: (absPath: string) => Promise<string>;
  /** Working directory used to relativize spec paths into repo-relative commit paths. */
  cwd: () => string;
  log: (msg: string) => void;
}

export const defaultDeps: CiDeps = {
  resolveConfig,
  runExploration,
  runDesign,
  makeGitHubClient: (ctx) => new RestGitHubClient(ctx),
  readInputFile,
  resolveStyleText,
  readFile: (p) => fsReadFile(p, "utf8"),
  cwd: () => process.cwd(),
  log: (m) => process.stderr.write(`${m}\n`),
};

export interface CiRunResult {
  /** True when the core run executed (false on a no-op gate). */
  ranCore: boolean;
  summary: CiSummary;
  /** The comment that was posted/updated, when the comment effect ran. */
  comment?: { action: "created" | "updated"; id: number };
  /** The follow-up PR, when the toggle ran it. */
  followupPr?: { url: string; number: number };
  /** Why a requested effect was skipped (fork / missing token / not a PR) — surfaced, never silent. */
  skippedEffects: string[];
}

/** Translate a single glob (`*`, `**`, `?`) into an anchored RegExp over POSIX paths. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Single pass so a `*` emitted by an earlier replacement (e.g. inside `(?:.*/)?`) is not re-expanded.
  const body = escaped.replace(/\*\*\/|\*\*|\*|\?/g, (m) => {
    if (m === "**/") return "(?:.*/)?"; // any directories (or none)
    if (m === "**") return ".*";
    if (m === "*") return "[^/]*";
    return "."; // ?
  });
  return new RegExp(`^${body}$`);
}

/** Does any glob match the file path? Empty glob list means "no filter" (always true at the call site). */
export function matchesAnyGlob(file: string, globs: string[]): boolean {
  const posix = file.replace(/\\/g, "/");
  return globs.some((g) => globToRegExp(g).test(posix));
}

/** Map inputs → the shared `ExploreInput` (config reused), exactly like the CLI/MCP adapters do. */
async function buildExploreInput(inputs: CiInputs, deps: CiDeps): Promise<ExploreInput> {
  const config = deps.resolveConfig({
    backend: inputs.backend,
    routing: inputs.routing,
    channel: inputs.channel,
  });
  const checklistText = inputs.checklist ? await deps.readInputFile(inputs.checklist, "Checklist") : undefined;
  const styleText = inputs.style ? await deps.resolveStyleText(inputs.style) : undefined;
  return {
    url: inputs.url,
    config,
    sessionName: inputs.session,
    checklistText,
    style: inputs.style,
    styleText,
    intoProject: inputs.intoProject,
    projectDir: inputs.projectDir,
  };
}

/** Absolute paths of the spec files Cairn wrote (project-fit ejection wins; else the greenfield sandbox). */
function generatedSpecPaths(result: ExploreResult): string[] {
  if (result.projectSpecFiles?.length) return result.projectSpecFiles;
  if (result.suite) return result.suite.files.map((f) => join(result.runDir, "tests", f.path));
  return [];
}

/** Read the generated specs and turn them into repo-relative commit files for a follow-up PR. */
async function collectCommitFiles(result: ExploreResult, deps: CiDeps): Promise<CommitFile[]> {
  const root = deps.cwd();
  const files: CommitFile[] = [];
  for (const abs of generatedSpecPaths(result)) {
    const content = await deps.readFile(abs);
    const rel = relative(root, resolve(abs)).replace(/\\/g, "/");
    files.push({ path: rel, content });
  }
  return files;
}

/** Build the compact validation roll-up the summary renders. */
function compactValidation(result: ExploreResult): CiSummary["validation"] {
  const v = result.validation;
  if (!v) return undefined;
  return {
    greenRatio: v.greenRatio,
    passed: v.results.filter((r) => r.status === "passed").length,
    failed: v.results.filter((r) => r.status === "failed").length,
    flaky: v.flakyCount,
  };
}

/**
 * Run the CI / PR bot end to end. Reads inputs + context from `env`/`event` (injected so tests need no
 * files), runs the core, and applies the GitHub effects guarded by toggles + permission reality (fork
 * PRs and missing tokens are read-only — those effects are skipped with a logged reason, never crash).
 */
export async function runCi(
  env: Env = process.env,
  event: PullRequestEvent = {},
  deps: CiDeps = defaultDeps,
): Promise<CiRunResult> {
  const inputs = parseInputs(env);
  const ctx = buildContext(env, event);
  const skippedEffects: string[] = [];

  // A token is required for any GitHub effect. Fork PRs get a read-only token under `pull_request`,
  // so we also treat forks as "cannot write" (maintainers opt into pull_request_target deliberately).
  const canWrite = Boolean(ctx.token) && !ctx.isFork && ctx.prNumber !== undefined;
  const github = ctx.token ? deps.makeGitHubClient(ctx) : undefined;
  if (!ctx.token) skippedEffects.push("no github-token — GitHub effects skipped");
  else if (ctx.isFork) skippedEffects.push("fork PR (read-only token) — GitHub effects skipped");
  else if (ctx.prNumber === undefined) skippedEffects.push("not a pull_request event — GitHub effects skipped");

  // Changed-surface gate: when `paths` is set, only run if the PR touched a matching file. Needs read
  // access to the PR's files; if we can't read them we conservatively proceed (better a run than a miss).
  if (inputs.paths.length > 0 && github && ctx.prNumber !== undefined) {
    const changed = await github.listChangedFiles(ctx.prNumber);
    const hit = changed.some((f) => matchesAnyGlob(f.filename, inputs.paths));
    if (!hit) {
      deps.log("No changed files match `paths` — skipping generation (no-op).");
      const summary: CiSummary = {
        mode: inputs.mode,
        url: inputs.url,
        caseCount: 0,
        specCount: 0,
        noOpReason: "no changed surfaces matched the configured `paths`",
      };
      const comment = inputs.comment && canWrite ? await github.upsertComment(ctx.prNumber, renderCiSummary(summary)) : undefined;
      return { ranCore: false, summary, comment, skippedEffects };
    }
  }

  // Core run (the same entry points the CLI uses).
  deps.log(`Running cairn ${inputs.mode} against ${inputs.url} …`);
  const exploreInput = await buildExploreInput(inputs, deps);
  let result: ExploreResult | DesignResult;
  let exploreResult: ExploreResult | undefined;
  if (inputs.mode === "explore") {
    exploreResult = await deps.runExploration(exploreInput);
    result = exploreResult;
  } else {
    result = await deps.runDesign(exploreInput);
  }

  const summary: CiSummary = {
    mode: inputs.mode,
    url: inputs.url,
    runId: result.runId,
    caseCount: result.testCases.length,
    specCount: exploreResult ? generatedSpecPaths(exploreResult).length : 0,
    validation: exploreResult ? compactValidation(exploreResult) : undefined,
    pilot: exploreResult?.pilot
      ? { verdict: exploreResult.pilot.verdict, reason: exploreResult.pilot.reason }
      : undefined,
    cost: { totalTokens: result.cost.totalTokens, totalCostUsd: result.cost.totalCostUsd },
    projectTestDir: exploreResult?.projectTestDir,
  };

  // Optional follow-up PR — ONLY on explicit toggle, with writable context and actual specs to carry.
  let followupPr: { url: string; number: number } | undefined;
  if (inputs.openPr) {
    if (inputs.mode !== "explore") {
      skippedEffects.push("open-pr ignored — only `explore` mode produces code");
    } else if (!canWrite || !github) {
      skippedEffects.push("open-pr requested but context is read-only — follow-up PR skipped");
    } else {
      const files = await collectCommitFiles(exploreResult!, deps);
      if (files.length === 0) {
        skippedEffects.push("open-pr requested but no specs were generated — follow-up PR skipped");
      } else {
        const branch = `${inputs.prBranch}-${ctx.prNumber}`;
        followupPr = await github.openFollowupPr({
          branch,
          baseBranch: ctx.headRef ?? ctx.baseRef ?? "main",
          commitMessage: inputs.commitMessage,
          title: inputs.prTitle,
          body: `Generated by Cairn for #${ctx.prNumber}.`,
          files,
        });
        summary.followupPr = followupPr;
        deps.log(`Opened follow-up PR: ${followupPr.url}`);
      }
    }
  }

  // Summary comment (idempotent upsert) — last, so it reflects the follow-up PR.
  let comment: { action: "created" | "updated"; id: number } | undefined;
  if (inputs.comment) {
    if (canWrite && github && ctx.prNumber !== undefined) {
      comment = await github.upsertComment(ctx.prNumber, renderCiSummary(summary));
      deps.log(`${comment.action === "created" ? "Posted" : "Updated"} the summary comment.`);
    } else {
      skippedEffects.push("comment requested but context is read-only — comment skipped");
    }
  }

  return { ranCore: true, summary, comment, followupPr, skippedEffects };
}
