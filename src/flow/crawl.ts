import type { BrowserGateway } from "../browser/gateway.js";
import type { VerifiedElement } from "../browser/types.js";
import { parseAriaSnapshot } from "../observe/parse-aria.js";
import type { PageStudy } from "../observe/index.js";
import type { Transition } from "../probe/index.js";
import type { JourneyCase } from "../design/schema.js";
import type { SetupPlan } from "./setup.js";

/** One studied page in the flow graph. */
export interface FlowNode {
  url: string;
  study: PageStudy;
  verified: VerifiedElement[];
  /** Observed safe transitions on this page (empty for crawled nodes — kept lean for cost). */
  transitions: Transition[];
}

/** An observed navigation between two pages (a link click that changed the URL). */
export interface FlowEdge {
  from: string;
  to: string;
  via: { ref: string; role: string; name?: string };
}

/** The app's page/flow graph: studied pages + observed transitions between them. */
export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface CrawlDeps {
  gateway: BrowserGateway;
  onProgress?: (event: string) => void;
}

/**
 * Destructive / session-ending link names — NEVER followed during a crawl (would log us out or
 * mutate data mid-walk, breaking both session reuse and read-only safety).
 */
const DESTRUCTIVE = /\b(log\s?out|sign\s?out|logout|signout|delete|remove|deactivate|close account)\b/i;

/** Same-origin check — the crawl stays inside the app under test, never wanders to external sites. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Normalize a URL for the visited set: drop the hash + a trailing slash (same page, different anchor). */
function norm(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return u.replace(/#.*$/, "").replace(/\/$/, "");
  }
}

/**
 * #59 — follow in-app navigation from a start page to build the page/flow graph (nodes = studied
 * pages, edges = observed transitions). No LLM — pure browser mechanics over the gateway, reusing the
 * gateway's storageState across pages. Bounded by `maxPages`; destructive/external links are skipped.
 *
 * Per link: re-observe the source page (so its refs are valid again), click the link, observe where it
 * lands. A new in-app URL becomes a node (studied + verified); a revisit only records the edge.
 */
export async function crawlFlow(
  start: FlowNode,
  deps: CrawlDeps,
  opts: { maxPages: number },
): Promise<FlowGraph> {
  const { gateway } = deps;
  const nodes: FlowNode[] = [start];
  const edges: FlowEdge[] = [];
  const visited = new Set<string>([norm(start.url)]);
  const queue: FlowNode[] = [start];

  while (queue.length > 0 && nodes.length < opts.maxPages) {
    const node = queue.shift()!;
    const links = node.study.elements.filter(
      (e) => e.role === "link" && e.interactive && !DESTRUCTIVE.test(e.name ?? ""),
    );

    for (const link of links) {
      if (nodes.length >= opts.maxPages) break;

      // Reset to the source page so its synthesized refs resolve, then follow the link.
      await gateway.observe({ url: node.url });
      const clicked = await gateway.act({ kind: "click", ref: link.ref });
      if (!clicked.ok) continue;
      const obs = await gateway.observe({});

      // Stay in-app; never leave the origin under test.
      if (!sameOrigin(start.url, obs.url)) continue;

      edges.push({ from: node.url, to: obs.url, via: { ref: link.ref, role: link.role, name: link.name } });

      const key = norm(obs.url);
      if (visited.has(key)) continue; // revisit → edge only, no new node
      visited.add(key);

      const elements = parseAriaSnapshot(obs.ariaSnapshot);
      const study: PageStudy = {
        url: obs.url,
        screenshotB64: obs.screenshotB64,
        ariaYaml: obs.ariaSnapshot,
        capturedBy: obs.capturedBy,
        elements,
        consoleErrors: obs.consoleErrors,
      };
      let verified: VerifiedElement[];
      try {
        verified = await gateway.verify(elements);
      } catch {
        verified = elements.map((e) => ({ ...e, count: -1, verified: false }));
      }
      const next: FlowNode = { url: obs.url, study, verified, transitions: [] };
      nodes.push(next);
      queue.push(next);
      deps.onProgress?.(`flow — visited ${obs.url} (${nodes.length}/${opts.maxPages})`);
    }
  }

  return { nodes, edges };
}

/** Compact flow payload for report.json — pages + edges + journeys (+ setup), WITHOUT screenshots/ARIA. */
export interface FlowReport {
  pages: { url: string; interactive: number }[];
  edges: FlowEdge[];
  journeys: JourneyCase[];
  /** #60: per-journey structured setup plans (omitted when setup didn't run). */
  setup?: SetupPlan[];
}

/** Build the report.json `flow` block (undefined when no crawl happened). Pure — unit-testable. */
export function flowReportPayload(
  graph?: FlowGraph,
  journeys?: JourneyCase[],
  setupPlans?: SetupPlan[],
): FlowReport | undefined {
  if (!graph) return undefined;
  return {
    pages: graph.nodes.map((n) => ({
      url: n.url,
      interactive: n.verified.filter((v) => v.interactive && v.count >= 1).length,
    })),
    edges: graph.edges,
    journeys: journeys ?? [],
    ...(setupPlans ? { setup: setupPlans } : {}),
  };
}
