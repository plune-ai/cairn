import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_PROMPTS } from "./local/index.js";

export { LOCAL_PROMPTS } from "./local/index.js";

export interface CompiledPrompt {
  name: string;
  text: string;
  version: number | "local";
  isFallback: boolean;
}

/** Source of versioned prompts (e.g. Langfuse). Returns null if the prompt is absent. */
export interface PromptFetcher {
  fetch(name: string): Promise<{ text: string; version: number } | null>;
}

export interface PromptRegistryOptions {
  fetcher?: PromptFetcher;
  local?: Record<string, string>;
  /** Directory of .md overrides (default ./prompts): edit a prompt without rebuilding. `<name>.md` > local constant. */
  overridesDir?: string;
}

function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

/**
 * Prompt registry (ADR-0004): Langfuse first (if a fetcher is injected), otherwise the local fallback.
 * `{{var}}` is interpolated; a missing variable → empty. The bot works offline on local prompts.
 */
export class PromptRegistry {
  private readonly local: Record<string, string>;
  private readonly overridesDir: string;
  constructor(private readonly opts: PromptRegistryOptions = {}) {
    this.local = opts.local ?? LOCAL_PROMPTS;
    this.overridesDir = opts.overridesDir ?? "prompts";
  }

  async getPrompt(name: string, vars: Record<string, string> = {}): Promise<CompiledPrompt> {
    let raw: string | undefined;
    let version: number | "local" = "local";
    let isFallback = true;

    if (this.opts.fetcher) {
      try {
        const remote = await this.opts.fetcher.fetch(name);
        if (remote) {
          raw = remote.text;
          version = remote.version;
          isFallback = false;
        }
      } catch {
        // Langfuse unavailable → local fallback.
      }
    }

    if (raw === undefined) {
      try {
        raw = await readFile(join(this.overridesDir, `${name}.md`), "utf8");
      } catch {
        // no .md override → local constant
      }
    }

    if (raw === undefined) {
      raw = this.local[name];
      if (raw === undefined) {
        throw new Error(`Prompt '${name}' not found (neither in Langfuse nor locally).`);
      }
    }

    return { name, text: interpolate(raw, vars), version, isFallback };
  }
}
