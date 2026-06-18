/**
 * C1-01 — shared CLI core (the umbrella seam).
 *
 * Everything a modality reuses lives here so a new modality is a thin add, not a fork:
 *  - resolveConfig: the one place CLI flags become an AppConfig
 *  - printCost: the shared cost footer
 *  - the Modality type + registry + dispatch (runModality) + gated-stub notice
 */
export { resolveConfig } from "./config.js";
export type { ConfigFlags } from "./config.js";
export { printCost } from "./reporting.js";
export { makeCliProgress } from "./progress.js";
export type { CliProgress } from "./progress.js";
export { defaultIO, gatedNotice } from "./modality.js";
export type { Modality, ModalityContext, IO, Sink } from "./modality.js";
export { MODALITIES, getModality, runModality } from "./registry.js";
