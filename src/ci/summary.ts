/**
 * INT-02 (#50) — compose the PR summary comment from a CI run result.
 *
 * Pure string assembly (no I/O) so it is unit-testable directly. The output is GitHub-flavored
 * markdown; the {@link ./github.ts} client stamps the idempotency marker before posting.
 */

/** Validation roll-up (mirrors the compact shape the MCP layer already produces). */
export interface SummaryValidation {
  greenRatio: number;
  passed: number;
  failed: number;
  flaky: number;
}

/** Everything the comment renders — filled by the orchestrator from the core run result. */
export interface CiSummary {
  mode: "explore" | "design";
  url: string;
  runId?: string;
  caseCount: number;
  specCount: number;
  validation?: SummaryValidation;
  pilot?: { verdict: string; reason: string };
  cost?: { totalTokens: number; totalCostUsd: number | null };
  /** Where specs were written into the host Playwright project (#51), when into-project ran. */
  projectTestDir?: string;
  /** The opened follow-up PR, when the toggle ran it. */
  followupPr?: { url: string; number: number };
  /** Set when the run was skipped (e.g. no changed surfaces) — renders a no-op note instead of metrics. */
  noOpReason?: string;
}

const TITLE = "### 🪨 Cairn — generated UI tests";

/** Format a cost line, tolerating an unknown (null) USD total. */
function costLine(cost: CiSummary["cost"]): string {
  if (!cost) return "";
  const usd = cost.totalCostUsd === null ? "n/a" : `$${cost.totalCostUsd.toFixed(4)}`;
  return `- **Cost:** ${cost.totalTokens.toLocaleString("en-US")} tokens · ${usd}`;
}

/** Render the full comment body (without the hidden marker — the client adds that). */
export function renderCiSummary(s: CiSummary): string {
  if (s.noOpReason) {
    return [TITLE, "", `No tests generated — ${s.noOpReason}.`].join("\n");
  }

  const lines: string[] = [TITLE, ""];
  lines.push(`Ran \`cairn ${s.mode}\` against \`${s.url}\`.`, "");

  lines.push(`- **Test cases:** ${s.caseCount}`);
  if (s.mode === "explore") lines.push(`- **Spec files:** ${s.specCount}`);

  if (s.validation) {
    const pct = Math.round(s.validation.greenRatio * 100);
    lines.push(
      `- **Validation:** ${pct}% green — ${s.validation.passed} passed, ` +
        `${s.validation.failed} failed, ${s.validation.flaky} flaky`,
    );
  }
  if (s.pilot) lines.push(`- **Pilot verdict:** ${s.pilot.verdict} — ${s.pilot.reason}`);
  if (s.projectTestDir) lines.push(`- **Written to:** \`${s.projectTestDir}\``);
  const cost = costLine(s.cost);
  if (cost) lines.push(cost);

  if (s.followupPr) {
    lines.push("", `📦 Opened follow-up PR with the tests: ${s.followupPr.url} (#${s.followupPr.number}).`);
  } else if (s.mode === "explore" && s.specCount > 0) {
    lines.push("", "_Tests were generated in the workflow run. Enable `open-pr` to receive them as a follow-up PR._");
  }

  return lines.join("\n");
}
