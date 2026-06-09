import { PlaywrightLibBackend } from "./backends/playwright-lib.js";
import { PlaywrightCliBackend } from "./backends/playwright-cli.js";
import type { BrowserBackend, BrowserGateway } from "./gateway.js";
import type {
  ActResult,
  Action,
  BackendKind,
  ElementRef,
  ElementState,
  Observation,
  ObserveOptions,
  SessionApi,
  StorageState,
  TestRunReport,
  VerifiedElement,
} from "./types.js";

export * from "./gateway.js";
export * from "./types.js";

/** Factory config — browser only (independent of the LLM config). */
export interface GatewayConfig {
  backend: BackendKind;
  headless?: boolean;
  /** Saved session (cookies+localStorage) for authenticated observe. */
  storageState?: StorageState;
  /** Browser channel (chrome/msedge) — bypasses automation detection. */
  channel?: string;
}

/**
 * Composite gateway (ADR-0003): observe/act → backend per config; session/runTests → ALWAYS lib.
 */
class GatewayImpl implements BrowserGateway {
  constructor(
    private readonly observeBackend: BrowserBackend,
    private readonly libBackend: BrowserBackend,
  ) {}

  observe(opts: ObserveOptions): Promise<Observation> {
    return this.observeBackend.observe(opts);
  }
  act(action: Action): Promise<ActResult> {
    return this.observeBackend.act(action);
  }
  async verify(elements: ElementRef[]): Promise<VerifiedElement[]> {
    if (this.observeBackend.verify) return this.observeBackend.verify(elements);
    return elements.map((e) => ({ ...e, count: -1, verified: false }));
  }
  async getState(element: ElementRef): Promise<ElementState> {
    if (this.observeBackend.getState) return this.observeBackend.getState(element);
    return { visible: false, enabled: false };
  }
  session(): SessionApi {
    if (!this.libBackend.session) throw new Error("The lib backend does not provide session().");
    return this.libBackend.session();
  }
  runTests(globs: string[]): Promise<TestRunReport> {
    if (!this.libBackend.runTests) throw new Error("The lib backend does not provide runTests().");
    return this.libBackend.runTests(globs);
  }
  async close(): Promise<void> {
    await this.observeBackend.close();
    if (this.libBackend !== this.observeBackend) await this.libBackend.close();
  }
}

export function makeGateway(cfg: GatewayConfig): BrowserGateway {
  const lib = new PlaywrightLibBackend({
    headless: cfg.headless ?? true,
    storageState: cfg.storageState,
    channel: cfg.channel,
  });
  if (cfg.backend === "cli") {
    // observe/act → cli (token-efficient); session/runTests → lib (ADR-0003).
    return new GatewayImpl(new PlaywrightCliBackend(), lib);
  }
  return new GatewayImpl(lib, lib);
}
