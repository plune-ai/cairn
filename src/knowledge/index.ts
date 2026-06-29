import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** A knowledge file's scope (BORROW-03, #92): which run kind it applies to. */
export type KnowledgeScope = "web" | "api" | "all";

/** Run scope — a web run injects web+all, an api run injects api+all. */
export type RunScope = "web" | "api";

/** What a knowledge run is looking for: its kind + the target it matches file keys against. */
export interface KnowledgeQuery {
  /** Run scope. Default "web" (back-compat — existing `url:` files stay web-scoped). */
  scope?: RunScope;
  /** Web run target (page URL) — matched against a file's url/path/endpoint key. */
  url?: string;
  /** API run target (endpoint/path) — matched the same way for api-scoped files. #22 wires this. */
  endpoint?: string;
}

/** Parsed front-matter we care about: an explicit scope + the match key (`url || path || endpoint`). */
interface Frontmatter {
  scope?: KnowledgeScope;
  /** First present of `url:` / `path:` / `endpoint:` — the pattern matched against the run target. */
  pattern?: string;
}

function parseFrontmatter(raw: string): Frontmatter {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm?.[1]) return {};
  const lines = fm[1].split(/\r?\n/).map((l) => l.trim());
  const value = (key: string): string | undefined => {
    const line = lines.find((l) => new RegExp(`^${key}:`).test(l));
    return line ? line.replace(new RegExp(`^${key}:\\s*`), "").trim() : undefined;
  };
  const rawScope = value("scope")?.toLowerCase();
  // Only a recognized value counts; an empty/unknown scope falls back to the directory default.
  const scope = rawScope === "web" || rawScope === "api" || rawScope === "all" ? rawScope : undefined;
  // Key precedence: url || path || endpoint (a single file declares one of them).
  const pattern = value("url") ?? value("path") ?? value("endpoint");
  return { scope, pattern };
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** List `*.md` under `dir` (non-recursive); missing dir → []. */
async function mdFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * Load domain knowledge (.md with credentials/validation rules/notes), scope- and key-matched
 * (idea from explorbot's `KnowledgeTracker`, #92). Directory convention: `dir/` = web (keyed by
 * `url:`), `dir/api/` = api (keyed by `path:`/`endpoint:`); an explicit `scope:` front-matter
 * (web | api | all) overrides the directory default. `scope: all` (e.g. shared credentials) is
 * available to BOTH web and api runs.
 *
 * A file is injected when its scope matches the run (`run scope` or `all`) AND its key pattern is
 * contained in the run target (web → url, api → endpoint); a file with no key is global within its
 * scope. Back-compat: a base-dir file without `scope:` is web — existing `url:` files behave exactly
 * as before. Injected into the design prompt → the bot knows facts not visible in the snapshot.
 */
export async function loadKnowledge(dir: string, query: KnowledgeQuery = {}): Promise<string> {
  const runScope: RunScope = query.scope ?? "web";
  const target = (runScope === "api" ? query.endpoint : query.url) ?? "";

  // Candidates from the base dir (default web) and the api subdir (default api); scope: front-matter overrides.
  const candidates: { dir: string; file: string; dirDefault: KnowledgeScope }[] = [
    ...(await mdFiles(dir)).map((file) => ({ dir, file, dirDefault: "web" as const })),
    ...(await mdFiles(join(dir, "api"))).map((file) => ({ dir: join(dir, "api"), file, dirDefault: "api" as const })),
  ];

  const parts: string[] = [];
  for (const c of candidates) {
    const raw = await readFile(join(c.dir, c.file), "utf8");
    const { scope, pattern } = parseFrontmatter(raw);
    const fileScope = scope ?? c.dirDefault;
    if (fileScope !== "all" && fileScope !== runScope) continue; // wrong scope for this run
    if (pattern && !target.includes(pattern)) continue; // keyed file: target must contain the pattern
    const body = stripFrontmatter(raw);
    if (body.length > 0) parts.push(body);
  }
  return parts.join("\n\n");
}
