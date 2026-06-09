/**
 * Інтерактивний capture сесії (cookies + localStorage) для authed-дослідження.
 * Відкриває HEADED-браузер, чекає поки ви залогінитесь, зберігає storageState у .auth/<name>.storageState.json.
 *
 *   npm run session:save -- --url https://app.example.com/login --name myapp
 *
 * Запускай через `!` у Claude Code (потрібен інтерактивний термінал + видиме вікно браузера).
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
  console.error("Вкажи --url <login-url>");
  process.exit(1);
}
const name = arg("--name") ?? new URL(url).hostname.replace(/[^a-z0-9]+/gi, "-");

const authDir = resolve(process.cwd(), ".auth");
await mkdir(authDir, { recursive: true });
const statePath = join(authDir, `${name}.storageState.json`);

const waitSec = Number(arg("--wait") ?? "150");

// Google OAuth блокує автоматизовані браузери → реальний Chrome + приховуємо webdriver-прапор.
const channel = arg("--channel") ?? "chrome";
const launchArgs = ["--disable-blink-features=AutomationControlled"];
let browser: Browser;
try {
  browser = await chromium.launch({ headless: false, channel, args: launchArgs });
} catch {
  console.log(`Канал '${channel}' недоступний — використовую bundled chromium.`);
  browser = await chromium.launch({ headless: false, args: launchArgs });
}
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(url);

if (input.isTTY) {
  const rl = createInterface({ input, output });
  await rl.question(
    `\nВідкрито браузер на ${url}\nЗалогіньтесь у вікні. Коли опинитесь УСЕРЕДИНІ застосунку — натисніть Enter тут… `,
  );
  rl.close();
} else {
  console.log(
    `\nВідкрито браузер на ${url}\nЗалогіньтесь у вікні протягом ${waitSec}с — стан збережеться автоматично.\n(stdin не інтерактивний; за потреби збільш час: --wait <секунди>)`,
  );
  await new Promise((r) => setTimeout(r, waitSec * 1000));
}

await context.storageState({ path: statePath });
await browser.close();

console.log(`\n✓ Сесію збережено: ${statePath}`);
console.log(`  Ім'я сесії: ${name}`);
console.log(`  Далі: qa-bot explore --url ${url} --session ${name}`);
