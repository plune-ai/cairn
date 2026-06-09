import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** url pattern from frontmatter (the `url: ...` line), if present. */
function frontmatterUrl(raw: string): string | undefined {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm?.[1]) return undefined;
  const line = fm[1].split(/\r?\n/).find((l) => /^url:/.test(l.trim()));
  return line ? line.replace(/^\s*url:\s*/, "").trim() : undefined;
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/**
 * Load domain knowledge (.md with credentials/validation rules/notes), URL-matched (idea from explorbot).
 * A file without `url:` is global (always applied); with `url:` only when the pattern is contained in the page URL.
 * Injected into the design prompt → the bot knows facts not visible in the snapshot (reduces the oracle gap).
 */
export async function loadKnowledge(dir: string, url: string): Promise<string> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf8");
    const pattern = frontmatterUrl(raw);
    if (!pattern || url.includes(pattern)) {
      const body = stripFrontmatter(raw);
      if (body.length > 0) parts.push(body);
    }
  }
  return parts.join("\n\n");
}
