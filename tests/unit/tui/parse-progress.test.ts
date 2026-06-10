import { describe, it, expect } from "vitest";
import {
  parseNode,
  advanceNodes,
  completeNodes,
  seedNodes,
  EXPLORE_NODES,
} from "../../../src/tui/theme.js";

/**
 * Locks the load-bearing assumption: the dashboard derives node status from the
 * <node> prefix ONLY, identically for English (graph.ts) and Ukrainian (run.log) lines.
 */
describe("parseNode — language-agnostic node extraction", () => {
  it.each([
    ["validate — 85% green out of 20 tests", "validate"], // English (graph.ts)
    ["validate — 88% зелених із 8 тестів", "validate"], // Ukrainian (run.log)
    ["designTestCases — generated 18 cases", "designTestCases"],
    ["designTestCases — згенеровано 8 кейсів", "designTestCases"],
    ["observe — opening browser…", "observe"],
    ["observe — відкриваю браузер…", "observe"],
  ])("extracts node from %j", (line, node) => {
    expect(parseNode(line).node).toBe(node);
  });

  it("returns empty node when there is no separator", () => {
    expect(parseNode("starting up").node).toBe("");
  });
});

describe("advanceNodes — monotonic progression", () => {
  it("marks earlier nodes done and the active one running", () => {
    const nodes = advanceNodes(seedNodes(EXPLORE_NODES), "designTestCases");
    const state = Object.fromEntries(nodes.map((n) => [n.node, n.state]));
    expect(state.observe).toBe("done");
    expect(state.designTestCases).toBe("running");
    expect(state.validate).toBe("pending");
  });

  it("absorbs a skipped no-op node (exploreStates) when a later node starts", () => {
    const nodes = advanceNodes(seedNodes(EXPLORE_NODES), "probeInteractions");
    const state = Object.fromEntries(nodes.map((n) => [n.node, n.state]));
    expect(state.exploreStates).toBe("done");
    expect(state.probeInteractions).toBe("running");
  });

  it("ignores unknown post-graph nodes (score/pilot)", () => {
    const base = advanceNodes(seedNodes(EXPLORE_NODES), "validate");
    expect(advanceNodes(base, "score")).toEqual(base);
    expect(advanceNodes(base, "pilot")).toEqual(base);
  });

  it("completeNodes marks every node done", () => {
    const done = completeNodes(seedNodes(EXPLORE_NODES));
    expect(done.every((n) => n.state === "done")).toBe(true);
  });
});
