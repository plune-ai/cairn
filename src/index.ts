/**
 * QA Explorer Bot — public library API (Sprint 6: frozen for embedding).
 *
 * Example: import { runDesign, runAutomate, runExploration } from "@plune-ai/cairn";
 * Three entry points: explore (everything), design (cases only), automate (code from cases).
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const BOT_NAME = "@plune-ai/cairn" as const;
/** Read from package.json at load time — single source of truth, no manual drift. */
export const BOT_VERSION: string = pkg.version;

// Entry points.
export { runExploration, runDesign, runAutomate, buildExploreGraph, ExploreState } from "./agent/index.js";
export type {
  ExploreInput,
  ExploreResult,
  DesignResult,
  AutomateResult,
  ExploreDeps,
} from "./agent/index.js";

// Config.
export { loadConfig } from "./config/index.js";
export { resolveConfig } from "./core/index.js";
export type { AppConfig, Role, RolesConfig } from "./config/index.js";
export type { ConfigFlags } from "./core/index.js";

// Cost/token reporting (L1-01, ADR-0011).
export type { CostReport, RoleCost } from "./llm/cost.js";

// Run summary + LLM-call budget surfacing (L1-04, Box 3/4).
export { renderRunSummary } from "./agent/summary.js";
export type { BudgetReport, RunSummaryInput } from "./agent/summary.js";

// Domain types (output contracts).
export type { TestCase, DesignedCase } from "./design/index.js";
export type { PageStudy } from "./observe/index.js";
export type { GeneratedSuite } from "./codegen/index.js";
export type { Score } from "./eval/scorers.js";
export type { PilotVerdict } from "./eval/pilot.js";
export type { ValidationReport } from "./validate/index.js";
export type { ChecklistItem } from "./checklist/index.js";
export type { ElementRef, VerifiedElement, StorageState, BackendKind } from "./browser/index.js";
