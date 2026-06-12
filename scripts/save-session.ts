/**
 * Interactive session capture (cookies + localStorage) for authenticated exploration.
 * Opens a HEADED browser, waits for you to log in, saves storageState to .auth/<name>.storageState.json.
 *
 *   npm run session:save -- --url https://app.example.com/login --name myapp
 *
 * Run via `!` in Claude Code (requires an interactive terminal + a visible browser window).
 */
import { chromium, type Browser } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg("--url");
if (!url) {
  console.error("Provide --url <login-url>");
  process.exit(1);
}
const name = arg("--name") ?? new URL(url).hostname.replace(/[^a-z0-9]+/gi, "-");

const authDir = resolve(process.cwd(), ".auth");
await mkdir(authDir, { recursive: true });
const statePath = join(authDir, `${name}.storageState.json`);

const waitSec = Number(arg("--wait") ?? "150");

// Google OAuth blocks automated browsers → use real Chrome + hide the webdriver flag.
const channel = arg("--channel") ?? "chrome";
const launchArgs = ["--disable-blink-features=AutomationControlled"];
let browser: Browser;
try {
  browser = await chromium.launch({ headless: false, channel, args: launchArgs });
} catch {
  console.log(`Channel '${channel}' is not available — falling back to bundled chromium.`);
  browser = await chromium.launch({ headless: false, args: launchArgs });
}
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(url);

if (input.isTTY) {
  const rl = createInterface({ input, output });
  await rl.question(
    `\nBrowser opened at ${url}\nLog in via the browser window. Once you are INSIDE the application — press Enter here… `,
  );
  rl.close();
} else {
  console.log(
    `\nBrowser opened at ${url}\nLog in via the browser window within ${waitSec}s — state will be saved automatically.\n(stdin is not interactive; increase the timeout if needed: --wait <seconds>)`,
  );
  await new Promise((r) => setTimeout(r, waitSec * 1000));
}

await context.storageState({ path: statePath });
await browser.close();

console.log(`\n✓ Session saved: ${statePath}`);
console.log(`  Session name: ${name}`);
console.log(`  Next: cairn explore --url ${url} --session ${name}`);
