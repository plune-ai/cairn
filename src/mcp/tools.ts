import { z } from "zod";
import { resolveConfig } from "../core/config.js";
import { runExploration, runDesign, runAutomate } from "../agent/index.js";
import type { ExploreInput, ExploreResult, DesignResult, AutomateResult } from "../agent/index.js";
import type { TestCase } from "../design/index.js";
import type { ValidationReport } from "../validate/index.js";
import { readInputFile } from "../fs/run-dir.js";
import { resolveStyleText } from "../design/style.js";

/**
 * MCP tool layer (#49). Each tool is a THIN adapter over the shared core: validate input → reuse
 * `resolveConfig` (config / routing / cost) → call the SAME `runExploration` / `runDesign` the CLI
 * calls → return a compact structured result. No new generation logic lives here.
 *
 * Core is injected via {@link ToolDeps} so the handlers are unit-testable without a browser or LLM.
 */

/** Tool input shape (zod raw shape) — a subset of the `cairn explore` / `design` flags. */
export const TOOL_INPUT_SHAPE = {
  url: z.string().describe("Page URL to generate tests for"),
  session: z.string().optional().describe("Saved session name (.auth/<name>.storageState.json) for authenticated targets"),
  checklist: z.string().optional().describe("Path to a checklist file (md/text) that guides what to test"),
  style: z.string().optional().describe("Planning style or house-style pack (happy | negative | coverage | a pack name/path)"),
  routing: z.string().optional().describe("Role-routing preset: fast (Groq worker) | volume (OpenRouter worker) | volume-fast (Anthropic codegen — faster, recommended when OpenRouter codegen overruns timeouts)"),
  backend: z.string().optional().describe("Browser backend: lib (in-process, default) | cli"),
  channel: z.string().optional().describe("System browser channel, e.g. chrome (drives installed Chrome; helps OAuth)"),
  flow: z.boolean().optional().describe("Follow in-app navigation across pages → multi-page journey cases"),
  maxPages: z.number().int().positive().optional().describe("Max pages to crawl with flow (default 3)"),
  setup: z.boolean().optional().describe("For journeys (flow): plan starting-state setup (fixture / API seed)"),
  gaps: z.boolean().optional().describe("Suggest cases for the top untested surface"),
  critique: z.boolean().optional().describe("Design-time self-critique pass (prune weak cases + top up technique gaps)"),
  fresh: z.boolean().optional().describe("Ignore prior-run experience for this URL (full set, no delta)"),
};

export const ToolInputSchema = z.object(TOOL_INPUT_SHAPE);
export type ToolInput = z.infer<typeof ToolInputSchema>;

/** Core seam (injected) — the exact functions the CLI uses; mocked in tests. */
export interface ToolDeps {
  resolveConfig: typeof resolveConfig;
  runExploration: typeof runExploration;
  runDesign: typeof runDesign;
  runAutomate: typeof runAutomate;
}

export const defaultDeps: ToolDeps = { resolveConfig, runExploration, runDesign, runAutomate };

/** Compact a validation report into pass/fail/flaky counts (shared by explore + automate). */
function compactValidation(v: ValidationReport | undefined) {
  if (!v) return undefined;
  return {
    greenRatio: v.greenRatio,
    passed: v.results.filter((x) => x.status === "passed").length,
    failed: v.results.filter((x) => x.status === "failed").length,
    flaky: v.flakyCount,
  };
}

/** Map tool input → the shared `ExploreInput` exactly like `exploreModality` does (config reused). */
async function buildExploreInput(input: ToolInput, deps: ToolDeps): Promise<ExploreInput> {
  const config = deps.resolveConfig({ backend: input.backend, routing: input.routing, channel: input.channel });
  const checklistText = input.checklist ? await readInputFile(input.checklist, "Checklist") : undefined;
  const styleText = input.style ? await resolveStyleText(input.style) : undefined;
  return {
    url: input.url,
    config,
    sessionName: input.session,
    checklistText,
    style: input.style,
    styleText,
    fresh: input.fresh,
    critique: input.critique,
    flow: input.flow,
    maxPages: input.flow ? (input.maxPages ?? 3) : undefined,
    setup: input.setup,
    gaps: input.gaps,
  };
}

/** Compact, LLM-friendly view of a generated case (drops nothing essential, keeps the payload small). */
function compactCases(cases: TestCase[]) {
  return cases.map((c) => ({
    id: c.id,
    title: c.title,
    technique: c.technique,
    type: c.type,
    priority: c.priority,
    execution: c.execution,
    steps: c.steps,
    expected: c.expected,
    elementRefs: c.elementRefs,
  }));
}

export interface ExploreToolResult {
  runId: string;
  runDir: string;
  pageSemantics: string;
  testCases: ReturnType<typeof compactCases>;
  validation?: { greenRatio: number; passed: number; failed: number; flaky: number };
  scores: { name: string; value: number; comment?: string }[];
  pilot?: { verdict: string; reason: string; guidance: string };
  cost: ExploreResult["cost"];
  testCaseFiles: string[];
}

export async function exploreTool(input: ToolInput, deps: ToolDeps = defaultDeps): Promise<ExploreToolResult> {
  const r = await deps.runExploration(await buildExploreInput(input, deps));
  return {
    runId: r.runId,
    runDir: r.runDir,
    pageSemantics: r.analysis.pageSemantics,
    testCases: compactCases(r.testCases),
    validation: compactValidation(r.validation),
    scores: r.scores.map((s) => ({ name: s.name, value: s.value, comment: s.comment })),
    pilot: r.pilot ? { verdict: r.pilot.verdict, reason: r.pilot.reason, guidance: r.pilot.guidance } : undefined,
    cost: r.cost,
    testCaseFiles: r.testCaseFiles,
  };
}

export interface DesignToolResult {
  runId: string;
  runDir: string;
  pageSemantics: string;
  testCases: ReturnType<typeof compactCases>;
  scores: { name: string; value: number; comment?: string }[];
  cost: DesignResult["cost"];
  testCaseFiles: string[];
}

export async function designTool(input: ToolInput, deps: ToolDeps = defaultDeps): Promise<DesignToolResult> {
  const r = await deps.runDesign(await buildExploreInput(input, deps));
  return {
    runId: r.runId,
    runDir: r.runDir,
    pageSemantics: r.analysis.pageSemantics,
    testCases: compactCases(r.testCases),
    scores: r.scores.map((s) => ({ name: s.name, value: s.value, comment: s.comment })),
    cost: r.cost,
    testCaseFiles: r.testCaseFiles,
  };
}

/**
 * Input for the `automate` tool — the second half of the decoupled flow. Unlike explore/design (whose
 * input is a `url`), automate's input is a previous run that already holds ready ATC cases.
 */
export const AUTOMATE_INPUT_SHAPE = {
  run: z.string().describe("Run folder with ready ATC cases: runs/<id>, a bare <id>, or an absolute path"),
  validate: z.boolean().optional().describe("Run the generated tests after codegen (requires a session)"),
  session: z.string().optional().describe("Saved session name for validation"),
  routing: z.string().optional().describe("Role-routing preset: fast (Groq worker) | volume (OpenRouter worker) | volume-fast (Anthropic codegen — faster, recommended when OpenRouter codegen overruns timeouts)"),
  channel: z.string().optional().describe("System browser channel for validation, e.g. chrome"),
};

export const AutomateInputSchema = z.object(AUTOMATE_INPUT_SHAPE);
export type AutomateInput = z.infer<typeof AutomateInputSchema>;

export interface AutomateToolResult {
  runDir: string;
  specFiles: string[];
  validation?: ReturnType<typeof compactValidation>;
  cost: AutomateResult["cost"];
}

export async function automateTool(input: AutomateInput, deps: ToolDeps = defaultDeps): Promise<AutomateToolResult> {
  const config = deps.resolveConfig({ routing: input.routing, channel: input.channel });
  const r = await deps.runAutomate({
    runDir: input.run,
    config,
    validate: input.validate,
    sessionName: input.session,
  });
  return {
    runDir: r.runDir,
    specFiles: r.specFiles,
    validation: compactValidation(r.validation),
    cost: r.cost,
  };
}
