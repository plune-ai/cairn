/**
 * Graph-node knowledge + progress parsing for the live dashboard.
 *
 * CRITICAL: onProgress strings are localized (run.log is Ukrainian, graph.ts is English),
 * so ONLY the `<node>` token before " — " is reliable. Never parse numbers from the message;
 * those come from the typed result objects.
 */
import type { NodeStatus, Command } from "./types.js";

export const EXPLORE_NODES = [
  "observe",
  "identifyElements",
  "verifyLocators",
  "exploreStates",
  "probeInteractions",
  "designTestCases",
  "generateCode",
  "validate",
  "repair",
] as const;

export const DESIGN_NODES = [
  "observe",
  "identifyElements",
  "verifyLocators",
  "exploreStates",
  "probeInteractions",
  "designTestCases",
] as const;

export const AUTOMATE_NODES = ["generateCode", "validate"] as const;

export const NODE_LABELS: Record<string, string> = {
  observe: "Observe page",
  identifyElements: "Identify elements",
  verifyLocators: "Verify locators",
  exploreStates: "Explore states",
  probeInteractions: "Probe interactions",
  designTestCases: "Design test cases",
  generateCode: "Generate code",
  validate: "Validate",
  repair: "Repair",
};

export function nodesFor(command: Command): readonly string[] {
  if (command === "design") return DESIGN_NODES;
  if (command === "automate") return AUTOMATE_NODES;
  return EXPLORE_NODES; // explore (observe is a separate, graphless path)
}

export function seedNodes(list: readonly string[]): NodeStatus[] {
  return list.map((node) => ({ node, state: "pending" }));
}

/**
 * Extract the graph-node prefix from a progress line. Language-agnostic: only the
 * token before " — " is used (the message text is localized and must not be relied on).
 */
export function parseNode(event: string): { node: string; msg: string } {
  const i = event.indexOf(" — ");
  if (i === -1) return { node: "", msg: event };
  return { node: event.slice(0, i).trim(), msg: event.slice(i + 3) };
}

/**
 * Monotonic advance: when `activeNode` starts, every earlier node becomes done, it
 * becomes running, later nodes stay pending. This absorbs skipped no-op nodes
 * (e.g. exploreStates) and ignores unknown post-graph nodes (score/pilot/collect).
 */
export function advanceNodes(nodes: NodeStatus[], activeNode: string): NodeStatus[] {
  const idx = nodes.findIndex((n) => n.node === activeNode);
  if (idx === -1) return nodes;
  return nodes.map((n, i) => ({
    node: n.node,
    state: i < idx ? "done" : i === idx ? "running" : "pending",
  }));
}

/** Mark every node done — used when the run resolves successfully. */
export function completeNodes(nodes: NodeStatus[]): NodeStatus[] {
  return nodes.map((n) => ({ node: n.node, state: "done" }));
}
