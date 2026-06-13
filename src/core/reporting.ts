/**
 * C1-01 — shared core: the cost/summary footer every modality prints.
 *
 * `printCost` moved here verbatim out of cli/index.ts so all modalities print the SAME footer.
 * The default `write` is stdout, so output is byte-identical to the pre-extraction helper.
 */
import type { CostReport } from "../llm/cost.js";
import type { Sink } from "./modality.js";

/** Print the per-role cost + token summary (L1-01). `write` is injectable for tests. */
export function printCost(cost: CostReport, write: Sink = (s) => void process.stdout.write(s)): void {
  if (cost.perRole.length === 0) return;
  write("\n=== Cost (per role) ===\n");
  for (const c of cost.perRole) {
    const usd = c.costUsd === null ? "n/a" : `$${c.costUsd.toFixed(4)}`;
    write(`  ${c.role.padEnd(9)} ${c.calls} call(s)  ${c.inputTokens}→${c.outputTokens} tok  ${usd}\n`);
  }
  const total = cost.totalCostUsd === null ? "n/a (some prices unknown)" : `$${cost.totalCostUsd.toFixed(4)}`;
  write(`  ${"total".padEnd(9)} ${cost.totalTokens} tok  ${total}\n`);
}
