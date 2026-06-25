/**
 * INT-02 (#50) — CI / PR bot entry point.
 *
 * The thin runtime `cairn ci` drives: read the GitHub event payload (so we know the PR number, head/
 * base refs and fork status) and delegate to the injectable {@link runCi} orchestrator. Kept tiny on
 * purpose — all logic lives in the testable seams under `src/ci/`.
 */
import { readFile } from "node:fs/promises";
import { runCi } from "./run.js";
import type { PullRequestEvent } from "./inputs.js";

export { runCi, defaultDeps } from "./run.js";
export type { CiDeps, CiRunResult } from "./run.js";
export { parseInputs, buildContext } from "./inputs.js";
export type { CiInputs, CiContext } from "./inputs.js";
export { RestGitHubClient } from "./github.js";
export type { GitHubClient } from "./github.js";
export { renderCiSummary } from "./summary.js";
export type { CiSummary } from "./summary.js";

/** Best-effort read of the GitHub Actions event payload (`GITHUB_EVENT_PATH`). */
export async function readEvent(env: NodeJS.ProcessEnv = process.env): Promise<PullRequestEvent> {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as PullRequestEvent;
  } catch {
    return {};
  }
}

/** Run the CI bot from the live environment, surfacing skipped effects. Throws on a hard failure. */
export async function startCi(): Promise<void> {
  const event = await readEvent();
  const result = await runCi(process.env, event);
  for (const note of result.skippedEffects) process.stderr.write(`note: ${note}\n`);
  if (!result.ranCore) process.stderr.write("Cairn CI: no-op (changed-surface gate).\n");
}
