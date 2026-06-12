/**
 * QA Explorer Bot — public library API (Sprint 6: frozen for embedding).
 *
 * Example: import { runDesign, runAutomate, runExploration } from "@plune-ai/cairn";
 * Three entry points: explore (everything), design (cases only), automate (code from cases).
 */

export const BOT_NAME = "@plune-ai/cairn" as const;
export const BOT_VERSION = "0.1.0" as const;

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
export type { AppConfig } from "./config/index.js";

// Domain types (output contracts).
export type { TestCase, DesignedCase } from "./design/index.js";
export type { PageStudy } from "./observe/index.js";
export type { GeneratedSuite } from "./codegen/index.js";
export type { Score } from "./eval/scorers.js";
export type { PilotVerdict } from "./eval/pilot.js";
export type { ValidationReport } from "./validate/index.js";
export type { ChecklistItem } from "./checklist/index.js";
export type { ElementRef, VerifiedElement, StorageState, BackendKind } from "./browser/index.js";
