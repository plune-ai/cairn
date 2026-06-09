import type { BrowserGateway } from "../browser/gateway.js";
import type { BackendKind, ElementRef } from "../browser/types.js";
import { parseAriaSnapshot } from "./parse-aria.js";

export { parseAriaSnapshot } from "./parse-aria.js";

/** Model-ready normalized page observation. */
export interface PageStudy {
  url: string;
  screenshotB64: string;
  ariaYaml: string;
  elements: ElementRef[];
  capturedBy: BackendKind;
  /** Page JS errors (console.error + uncaught), if the backend captures them. */
  consoleErrors?: string[];
}

/**
 * Explore the page through the gateway and normalize it into a `PageStudy`
 * (the same shape regardless of the backend — ADR-0003).
 */
export async function capture(
  gateway: BrowserGateway,
  url: string,
  opts: { fullPage?: boolean } = {},
): Promise<PageStudy> {
  const obs = await gateway.observe({ url, fullPage: opts.fullPage });
  return {
    url: obs.url,
    screenshotB64: obs.screenshotB64,
    ariaYaml: obs.ariaSnapshot,
    elements: parseAriaSnapshot(obs.ariaSnapshot),
    capturedBy: obs.capturedBy,
    consoleErrors: obs.consoleErrors,
  };
}
