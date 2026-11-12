import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { changesServer, recordedUrl } from "../browser/click-effect.js";

/**
 * #285: the observe guard's policy for the validation run. Validation is a `playwright test` process of its own, so the
 * guard reaches it as a module: the run's tsconfig maps `@playwright/test` to it, which every generated spec (and the
 * API flows fixture) imports. It is `@playwright/test` with three fixtures added:
 * - every worker's browser gets a Fetch interception on the browser itself, as in observe's press browser: a request
 *   that changes the server (`changesServer`) and goes to a guarded origin is aborted, from any page, popup, frame or worker;
 * - the `request` fixture refuses the same requests before sending them (they never pass through a browser);
 * - after each test, what was blocked during it fails the test, with the method and URL, and is written to `log`.
 * A test runs alone in its worker, so what its worker blocked while it ran is its own.
 * Not covered: `page.request`, `context.request` and `playwright.request` contexts (API flows have their own gate),
 * and what the observe guard does not cover either (WebSocket messages, a GET that changes the server).
 */
function guardModule(pwTest: string, origins: string[], log: string): string {
  return `// Written by cairn for one validation run (#285): '@playwright/test' with the write guard on.
const pw = require(${JSON.stringify(pwTest)});
const { appendFileSync } = require('node:fs');
const ORIGINS = ${JSON.stringify(origins)};
const changesServer = ${changesServer.toString()};
const guarded = (method, url) => {
  if (!changesServer(method)) return false;
  try { return ORIGINS.length === 0 || ORIGINS.includes(new URL(url).origin); } catch { return true; }
};
const named = (method, url) => {
  let at = String(url).split(/[?#]/)[0];
  try { const u = new URL(url); at = u.origin + u.pathname; } catch {}
  return method.toUpperCase() + ' ' + at;
};
const SENDS = { post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE' };
const test = pw.test.extend({
  cairnWriteGuard: [async ({ browser }, use) => {
    const blocked = [];
    const cdp = await browser.newBrowserCDPSession();
    cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
      if (!guarded(request.method, request.url)) {
        cdp.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
        return;
      }
      blocked.push(named(request.method, request.url));
      cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => undefined);
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await use(blocked);
  }, { scope: 'worker', auto: true }],
  cairnWriteCheck: [async ({ cairnWriteGuard }, use) => {
    cairnWriteGuard.length = 0;
    await use();
    const mine = [...new Set(cairnWriteGuard.splice(0))];
    if (mine.length === 0) return;
    appendFileSync(${JSON.stringify(log)}, mine.map((m) => m + '\\n').join(''));
    throw new Error('The write guard blocked ' + mine.join(', ') + ': validation sends no writes to the target unless the run allows them (--allow-mutations).');
  }, { auto: true }],
  request: async ({ request, cairnWriteGuard }, use) => {
    await use(new Proxy(request, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args) => {
          const req = typeof args[0] === 'string' ? undefined : args[0];
          const method = key === 'fetch' ? (args[1]?.method ?? req?.method?.() ?? 'GET') : SENDS[key];
          const url = req?.url ? req.url() : String(args[0]);
          if (method && guarded(method, url)) {
            cairnWriteGuard.push(named(method, url));
            return Promise.reject(new Error('The write guard blocked ' + named(method, url) + '.'));
          }
          // called as a method: Playwright names the call in its errors after the frame that made it (not \`apply\`)
          return target[key](...args);
        };
      },
    }));
  },
});
Object.defineProperty(exports, '__esModule', { value: true });
${exportNames(pwTest).map((k) => `exports.${k} = pw.${k};`).join("\n")}
exports.test = test;
exports.default = test;
`;
}

/**
 * `@playwright/test`'s own export names, each written out: a spec run as an ES module finds a CommonJS module's names
 * only where they stand as `exports.name =`.
 */
function exportNames(pwTest: string): string[] {
  return Object.keys(createRequire(import.meta.url)(pwTest) as object).filter((k) => k !== "test" && k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k));
}

export interface InstalledGuard {
  /** The tsconfig the run's Playwright config names. */
  tsconfig: string;
  /** What the run blocked, each `METHOD url` once, as a report shows a URL; the guard's log is gone after. */
  blocked(): Promise<string[]>;
}

/** Write the guard into the run (`runDir` absolute); `origins` empty guards every origin. */
export async function installWriteGuard(runDir: string, origins: string[], pwTest: string): Promise<InstalledGuard> {
  const module = join(runDir, "write-guard.cjs");
  const tsconfig = join(runDir, "write-guard.tsconfig.json");
  const log = join(runDir, "write-guard.log");
  await rm(log, { force: true });
  await writeFile(module, guardModule(pwTest, [...new Set(origins.map((o) => new URL(o).origin))], log), "utf8");
  await writeFile(tsconfig, JSON.stringify({ compilerOptions: { allowJs: true, paths: { "@playwright/test": [module] } } }, null, 2), "utf8");
  return {
    tsconfig,
    blocked: async () => {
      const text = await readFile(log, "utf8").catch(() => "");
      await rm(log, { force: true });
      const lines = text.split("\n").filter(Boolean);
      return [...new Set(lines.map((l) => { const i = l.indexOf(" "); return `${l.slice(0, i)} ${recordedUrl(l.slice(i + 1))}`; }))];
    },
  };
}
