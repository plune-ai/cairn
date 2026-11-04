import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRunView, writeRunView } from "../../src/view/index.js";
import type { ScreencastEntry } from "../../src/validate/runner.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-view-"));
  await mkdir(join(dir, "screencasts", "shop"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(entries: ScreencastEntry[]): Promise<void> {
  await writeFile(join(dir, "screencasts", "screencasts.json"), JSON.stringify(entries), "utf8");
  for (const e of entries) await writeFile(join(dir, e.video), "webm", "utf8");
}

const shop: ScreencastEntry = {
  test: "shop",
  video: "screencasts/shop/video.webm",
  timing: "trace",
  chapters: [
    { title: "open the shop", atMs: 0 },
    { title: "add an item", atMs: 1500 },
    { title: "see it added", atMs: 65_250 },
  ],
};

describe("#211 static run viewer", () => {
  it("lists the chapters with their times and seek offsets", async () => {
    await fixture([shop]);
    const html = await renderRunView(dir);
    expect(html).toContain("open the shop");
    expect(html).toContain('data-at="1.5"');
    expect(html).toContain("0:01");
    expect(html).toContain("1:05");
  });

  it("references the local video by a relative path, self-contained", async () => {
    await fixture([shop]);
    const html = await renderRunView(dir);
    expect(html).toContain('src="screencasts/shop/video.webm"');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("base64");
  });

  it("shows only the video and one sentence when there are no chapters", async () => {
    await fixture([{ ...shop, chapters: [] }]);
    const html = await renderRunView(dir);
    expect(html).toContain("<video");
    expect(html).toContain("This run recorded no steps.");
    expect(html).not.toContain("data-at=");
  });

  it("fails naming the run directory when there is no video", async () => {
    await expect(renderRunView(dir)).rejects.toThrow(dir);
    await fixture([]);
    await expect(writeRunView(dir)).rejects.toThrow(/no video/i);
  });

  it("escapes strings taken from the run", async () => {
    await fixture([{ ...shop, test: '<b>"t"</b>', chapters: [{ title: "<img src=x onerror=alert(1)>", atMs: 0 }] }]);
    const html = await renderRunView(dir);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<b>");
  });

  it("writes view.html into the run dir and returns its path", async () => {
    await fixture([shop]);
    const p = await writeRunView(dir);
    expect(p).toBe(join(dir, "view.html"));
    expect(await readFile(p, "utf8")).toContain("open the shop");
  });
});
