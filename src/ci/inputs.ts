/**
 * INT-02 (#50) — CI / PR bot input layer.
 *
 * Parse + validate the GitHub Action's `inputs:` from the environment. GitHub passes each declared
 * input as an `INPUT_<NAME>` env var (name upper-cased, spaces → `_`) — exactly what `@actions/core`
 * reads — so this module needs no Actions toolkit dependency and stays trivially unit-testable by
 * handing it a plain env record.
 *
 * Provider keys (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, …) are NOT read here: they flow straight into
 * `process.env` from repo secrets and are consumed by `resolveConfig`/`loadConfig` like everywhere
 * else — never hardcoded, never echoed.
 */

type Env = Record<string, string | undefined>;

/** Read one Action input from env, replicating `@actions/core.getInput` name→env mapping. */
export function getInput(env: Env, name: string): string | undefined {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Parse a boolean input the way Actions' YAML truthiness works (`true`/`false`, case-insensitive). */
function getBool(env: Env, name: string, fallback: boolean): boolean {
  const v = getInput(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`Input "${name}" must be "true" or "false" (got "${v}").`);
}

/** Split a multiline / comma-separated input into trimmed, non-empty entries. */
function getList(env: Env, name: string): string[] {
  const raw = getInput(env, name);
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The exploration mode the action drives — `explore` emits code (needed for a follow-up PR). */
export type CiMode = "explore" | "design";

/** Validated, normalized inputs for one CI run. Mirrors the `cairn explore`/`design` flag surface. */
export interface CiInputs {
  url: string;
  mode: CiMode;
  session?: string;
  checklist?: string;
  style?: string;
  routing?: string;
  backend?: string;
  channel?: string;
  /** Write specs into the host project's Playwright `testDir` (#51) instead of greenfield `runs/`. */
  intoProject: boolean;
  projectDir?: string;
  /** Optional glob filter on the PR's changed files — no match → the run is a no-op (changed-surface gate). */
  paths: string[];
  /** Post / update the summary comment on the PR. */
  comment: boolean;
  /** Open a follow-up PR carrying the generated tests (toggle, default off). */
  openPr: boolean;
  /** Branch name for the follow-up PR. */
  prBranch: string;
  /** Commit message for the follow-up PR. */
  commitMessage: string;
  /** Title for the follow-up PR (defaults from the commit message). */
  prTitle: string;
}

/**
 * Parse + validate inputs from `env`. Throws a single, clean error on the first problem (missing
 * `url`, bad boolean, bad `mode`) so the action fails fast with an actionable message rather than
 * deep inside the core run.
 */
export function parseInputs(env: Env = process.env): CiInputs {
  const url = getInput(env, "url");
  if (!url) throw new Error('Required input "url" is missing.');

  const modeRaw = (getInput(env, "mode") ?? "explore").toLowerCase();
  if (modeRaw !== "explore" && modeRaw !== "design") {
    throw new Error(`Input "mode" must be "explore" or "design" (got "${modeRaw}").`);
  }
  const mode = modeRaw as CiMode;

  const commitMessage =
    getInput(env, "commit-message") ?? "test: update generated Playwright tests (cairn)";

  return {
    url,
    mode,
    session: getInput(env, "session"),
    checklist: getInput(env, "checklist"),
    style: getInput(env, "style"),
    routing: getInput(env, "routing"),
    backend: getInput(env, "backend"),
    channel: getInput(env, "channel"),
    intoProject: getBool(env, "into-project", true),
    projectDir: getInput(env, "project-dir"),
    paths: getList(env, "paths"),
    comment: getBool(env, "comment", true),
    openPr: getBool(env, "open-pr", false),
    prBranch: getInput(env, "pr-branch") ?? "cairn/update-tests",
    commitMessage,
    prTitle: getInput(env, "pr-title") ?? commitMessage,
  };
}

/** GitHub-provided run context (repo, PR number, refs) — distinct from user-configured inputs. */
export interface CiContext {
  /** `owner/repo` from `GITHUB_REPOSITORY`. */
  owner: string;
  repo: string;
  /** PR number from the event payload (undefined when not a pull_request event). */
  prNumber?: number;
  /** Head branch (where a follow-up PR's commit lands / branches from). */
  headRef?: string;
  /** Base branch the PR targets. */
  baseRef?: string;
  /** REST API base (GitHub.com or GHES) — `GITHUB_API_URL`. */
  apiUrl: string;
  /** Auth token from env (`github-token` input → `INPUT_GITHUB-TOKEN`, falling back to `GITHUB_TOKEN`). */
  token?: string;
  /** True when the PR comes from a fork — the token is typically read-only, so write effects are skipped. */
  isFork: boolean;
}

/** Minimal shape of the slice of the `pull_request` event payload we consume (for testable injection). */
export interface PullRequestEvent {
  pull_request?: {
    number?: number;
    head?: { ref?: string; repo?: { full_name?: string } | null };
    base?: { ref?: string; repo?: { full_name?: string } | null };
  };
  number?: number;
}

/**
 * Build the run context from env + an already-parsed event payload (injected so tests need no file).
 * `repoFullName` defaults from `GITHUB_REPOSITORY`; fork detection compares head/base repo full names.
 */
export function buildContext(env: Env = process.env, event: PullRequestEvent = {}): CiContext {
  const repoFull = env.GITHUB_REPOSITORY ?? "";
  const [owner = "", repo = ""] = repoFull.split("/");

  const pr = event.pull_request;
  const prNumber = pr?.number ?? event.number;
  const headRepo = pr?.head?.repo?.full_name;
  const baseRepo = pr?.base?.repo?.full_name ?? (repoFull || undefined);
  const isFork = Boolean(headRepo && baseRepo && headRepo !== baseRepo);

  return {
    owner,
    repo,
    prNumber: typeof prNumber === "number" ? prNumber : undefined,
    headRef: pr?.head?.ref ?? env.GITHUB_HEAD_REF,
    baseRef: pr?.base?.ref ?? env.GITHUB_BASE_REF,
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    token: getInput(env, "github-token") ?? env.GITHUB_TOKEN,
    isFork,
  };
}
