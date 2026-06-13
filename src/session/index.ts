import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StorageState } from "../browser/types.js";

// First-class interactive capture (L1-05) — re-exported so consumers can
// `import { captureSession } from "@plune-ai/cairn/.../session"`. Defined in a
// separate module so the heavy browser/readline deps stay off the SessionStore path.
export { captureSession } from "./capture.js";
export type { CaptureSessionOptions, CaptureSessionResult } from "./capture.js";

/** File suffix for a saved session (one storageState per name). */
const SESSION_SUFFIX = ".storageState.json";

/**
 * Actionable message for a missing named session — NEVER a raw ENOENT.
 * Names the exact fix so a design partner can self-serve (L1-05).
 */
export function missingSessionMessage(name: string): string {
  return `No saved session "${name}". Capture it: cairn session capture --url <loginUrl> --name ${name}`;
}

/**
 * Actionable message when a supplied session looks expired (landed on a login page).
 * Used to fail fast instead of silently exploring the sign-in screen (L1-05).
 */
export function expiredSessionMessage(name?: string): string {
  const label = name ? ` "${name}"` : "";
  const nameArg = name ?? "<name>";
  return (
    `Session${label} looks expired — the first page looks like a login screen. ` +
    `Re-capture it: cairn session capture --url <loginUrl> --name ${nameArg}`
  );
}

/**
 * Browser session persistence (storageState: cookies + localStorage), ADR-0003.
 * Files live outside git (.auth/ in .gitignore). Security: never commit them.
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  pathFor(name: string): string {
    return join(this.dir, `${name}${SESSION_SUFFIX}`);
  }

  async save(name: string, state: StorageState): Promise<void> {
    const file = this.pathFor(name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2), "utf8");
  }

  async load(name: string): Promise<StorageState> {
    // Missing-session UX: actionable message naming the fix, never a raw ENOENT (L1-05).
    if (!(await this.exists(name))) throw new Error(missingSessionMessage(name));
    return this.loadFile(this.pathFor(name));
  }

  /**
   * Load storageState from an arbitrary file (names vary across projects) and NORMALIZE it:
   * accepts the classic {cookies, origins}, as well as partial ones (cookies only / origins only → pads with []).
   * If there are neither cookies nor origins (bare tokens) — throws a clear error.
   */
  async loadFile(filePath: string): Promise<StorageState> {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`File '${filePath}' is not a storageState JSON object.`);
    }
    const obj = parsed as { cookies?: unknown; origins?: unknown };
    const hasCookies = Array.isArray(obj.cookies);
    const hasOrigins = Array.isArray(obj.origins);
    if (!hasCookies && !hasOrigins) {
      throw new Error(
        `File '${filePath}' does not look like a Playwright storageState (no cookies/origins arrays). ` +
          `Capture the session via 'npm run session:save' or convert it into the {cookies, origins} form.`,
      );
    }
    return {
      cookies: hasCookies ? (obj.cookies as StorageState["cookies"]) : [],
      origins: hasOrigins ? (obj.origins as StorageState["origins"]) : [],
    };
  }

  async exists(name: string): Promise<boolean> {
    try {
      await access(this.pathFor(name));
      return true;
    } catch {
      return false;
    }
  }

  /** Names of saved sessions (sorted). A missing sessions dir yields [] (not an error). */
  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.endsWith(SESSION_SUFFIX))
      .map((f) => f.slice(0, -SESSION_SUFFIX.length))
      .sort();
  }

  /** Delete a saved session. Returns true if a file was removed, false if it did not exist. */
  async remove(name: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(name));
      return true;
    } catch {
      return false;
    }
  }

  /** Structural check: must be { cookies: [], origins: [] }. */
  isValid(state: unknown): state is StorageState {
    if (typeof state !== "object" || state === null) return false;
    const s = state as Record<string, unknown>;
    return Array.isArray(s.cookies) && Array.isArray(s.origins);
  }
}

const LOGIN_HINTS = /вхід|увійти|sign\s?in|log\s?in|авторизац|\blogin\b|запрошенн|invitation/i;

/**
 * A "this is a login page" heuristic — for detecting an EXPIRED session (a silent redirect to sign-in).
 * Relies on the page semantics (the LLM description) or the dominance of a sign-in element when there are few elements.
 */
export function looksLikeLoginPage(pageSemantics: string, elementNames: string[]): boolean {
  if (LOGIN_HINTS.test(pageSemantics)) return true;
  const hasSignIn = elementNames.some((n) => /sign\s?in|увійти|sign in with/i.test(n));
  return hasSignIn && elementNames.length <= 3;
}
