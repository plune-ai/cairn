/**
 * #211: one finished run as a single static HTML page — the scenario video and its steps (chapters).
 * Reads what `--screencast` already writes (`screencasts/screencasts.json`); nothing leaves the machine.
 */
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScreencastEntry } from "../validate/runner.js";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A relative URL for the video: each path segment percent-encoded, then HTML-escaped. */
const videoHref = (p: string): string => escapeHtml(p.split("/").map(encodeURIComponent).join("/"));

/** m:ss (h:mm:ss from an hour) for a chapter offset. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${s}` : `${String(m)}:${s}`;
}

async function readEntries(runDir: string): Promise<ScreencastEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(runDir, "screencasts", "screencasts.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ScreencastEntry[] = [];
  for (const e of parsed as ScreencastEntry[]) {
    if (typeof e?.video !== "string") continue;
    try {
      await access(join(runDir, e.video));
    } catch {
      continue; // the .webm is gone: nothing to play
    }
    out.push({ ...e, chapters: Array.isArray(e.chapters) ? e.chapters : [] });
  }
  return out;
}

function renderEntry(e: ScreencastEntry, i: number): string {
  const items = e.chapters
    .map((c) => {
      const at = Math.max(0, Number(c.atMs) || 0);
      return `<li><button type="button" class="step" data-at="${String(at / 1000)}"><time>${formatTime(at)}</time><span>${escapeHtml(String(c.title))}</span></button></li>`;
    })
    .join("\n");
  const steps = e.chapters.length
    ? `<ol class="steps">\n${items}\n</ol>`
    : `<p class="none">This run recorded no steps.</p>`;
  return `<section class="scenario" id="s${String(i)}">
<h2>${escapeHtml(String(e.test ?? ""))}</h2>
<div class="body"><video controls preload="metadata" src="${videoHref(e.video)}"></video>
${steps}</div>
</section>`;
}

const STYLE = `:root{--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--accent:#0969da;--cur:#ddf4ff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--accent:#58a6ff;--cur:#17304d}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
h1{font-size:1.2rem}h2{font-size:1rem;margin:1.5rem 0 .5rem}
.body{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}
video{flex:2 1 420px;max-width:100%;background:#000}
.steps{flex:1 1 260px;list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:6px}
.steps li+li{border-top:1px solid var(--line)}
.step{all:unset;box-sizing:border-box;display:flex;gap:10px;width:100%;padding:8px 12px;cursor:pointer}
.step:hover{background:var(--cur)}
.step:focus-visible{outline:3px solid var(--accent);outline-offset:-3px}
.step[aria-current=true]{background:var(--cur);font-weight:600}
time{color:var(--muted);font-variant-numeric:tabular-nums;min-width:3.5em}
.none{flex:1 1 260px;color:var(--muted)}`;

const SCRIPT = `for (const sec of document.querySelectorAll('.scenario')) {
  const v = sec.querySelector('video');
  const steps = [...sec.querySelectorAll('.step')];
  const at = (b) => parseFloat(b.dataset.at);
  steps.forEach((b) => b.addEventListener('click', () => { v.currentTime = at(b); v.play().catch(() => {}); }));
  const mark = () => {
    let cur = null;
    for (const b of steps) if (at(b) <= v.currentTime + 0.05) cur = b;
    steps.forEach((b) => (b === cur ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
  };
  v.addEventListener('timeupdate', mark);
  v.addEventListener('seeked', mark);
}`;

/** Build the page for a run directory. Rejects, naming the directory, when the run has no video. */
export async function renderRunView(runDir: string): Promise<string> {
  const entries = await readEntries(runDir);
  if (entries.length === 0) {
    throw new Error(
      `No video found in run directory ${runDir}: expected screencasts/screencasts.json with a .webm (record one with --screencast).`,
    );
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cairn run</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Cairn run</h1>
${entries.map(renderEntry).join("\n")}
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** Write `view.html` into the run directory and return its path. */
export async function writeRunView(runDir: string): Promise<string> {
  const html = await renderRunView(runDir);
  const out = join(runDir, "view.html");
  await writeFile(out, html, "utf8");
  return out;
}

/** Open a file in the default browser (only ever called for `--open`). */
export function openInBrowser(file: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [file]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]]
    : ["xdg-open", [file]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    process.stderr.write(`Could not open a browser; open ${file} yourself.\n`);
  });
  child.unref();
}
