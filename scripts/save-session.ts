/**
 * Thin wrapper over captureSession (L1-05) — kept so `npm run session:save` keeps working.
 * The real, reusable logic lives in src/session/capture.ts and ALSO ships in dist/, so
 * npm-installed users can run the same thing via `cairn session capture`.
 *
 *   npm run session:save -- --url https://app.example.com/login --name myapp [--channel chrome] [--wait 150]
 *
 * Run via `!` in Claude Code (requires an interactive terminal + a visible browser window).
 */
import "dotenv/config";
import { captureSession } from "../src/session/index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg("--url");
if (!url) {
  console.error("Provide --url <login-url>");
  process.exit(1);
}

const waitRaw = arg("--wait");
const res = await captureSession({
  url,
  name: arg("--name"),
  // Default to real Chrome (helps with Google OAuth); captureSession falls back to bundled chromium.
  channel: arg("--channel") ?? "chrome",
  waitSeconds: waitRaw ? Number(waitRaw) : undefined,
  onLog: (m) => console.log(m),
});

console.log(`\n✓ Session saved: ${res.path}`);
console.log(`  Session name: ${res.name}`);
console.log(`  Next: cairn explore --url ${url} --session ${res.name}`);
