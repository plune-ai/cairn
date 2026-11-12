import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FLOW_FIXTURE_FILE } from "../api/flows.js";
import { V, caseFlips, changesServer, decoded, recordedPath, recordedUrl, secretShaped } from "../browser/click-effect.js";

/**
 * #285: observe's write guard for the validation run. Validation is a `playwright test` process of its own, so the guard
 * reaches it as a module: the run's tsconfig maps `@playwright/test`, `playwright/test`, `playwright` and `playwright-core` to it; every generated
 * spec (and the API flows fixture) imports the first. It is `@playwright/test` with these fixtures added:
 * - every worker's browser gets a Fetch interception on the browser itself, as observe's press browser: every request
 *   that changes the server (`changesServer`) is aborted, on every origin, from any page, popup, frame or worker;
 * - the `request` fixture and each test context's `request` (which `page.request` and `route.fetch()` use) refuse the
 *   same requests before sending them;
 * - after each test, a write it sent to a guarded origin (the target's, the studied pages', the API's) fails it, with
 *   the method and URL. One to any other origin (analytics, say), and a beacon or CSP report to any origin, fails
 *   nothing: it was aborted, and a test that needed it fails on its own assertions. A test runs alone in its worker, so what its worker blocked while it ran is its own.
 * Each block goes into `log` as it happens, with a line per worker the guard loaded in (`runSpecs` fails a run in which a
 * test ran where it did not). The re-exported `chromium`, `firefox` and `webkit` refuse to launch or connect: a browser
 * of a spec's own would have no guard.
 * `request.newContext()` (the export, and the `playwright` fixture's `playwright.request`) gives guarded API contexts too,
 * but to the API flows fixture's sign-in, whose login POST is by design (see `signInOfFlows`).
 * Not covered: a context a spec makes with `browser.newContext()` (its `request`, its pages' `page.request` and
 * `route.fetch()`; its pages' browser traffic is covered), the `playwright` fixture's browser types, WebSocket messages,
 * and a GET that changes the server.
 */
function guardModule(pwTest: string, origins: string[], log: string, flowsFixture: string): string {
  return `// Written by cairn for one validation run (#285): '@playwright/test' with the write guard on.
const pw = require(${JSON.stringify(pwTest)});
const { appendFileSync } = require('node:fs');
const ORIGINS = ${JSON.stringify(origins)};
const LOG = ${JSON.stringify(log)};
const V = ${JSON.stringify(V)};
const caseFlips = ${caseFlips.toString()};
const secretShaped = ${secretShaped.toString()};
const decoded = ${decoded.toString()};
const recordedPath = ${recordedPath.toString()};
const recordedUrl = ${recordedUrl.toString()};
const changesServer = ${changesServer.toString()};
const originOf = (url) => { try { return new URL(url).origin; } catch { return undefined; } };
// a URL that does not parse (a relative one) counts as the target's
const ours = (url) => { const o = originOf(url); return o === undefined || ORIGINS.length === 0 || ORIGINS.includes(o); };
const note = (line) => { try { appendFileSync(LOG, line + '\\n'); } catch {} };
/**
 * Record one blocked write: the target's go to the test that sent them (unless \`fails\` is false); the rest are only
 * logged, by origin.
 */
const block = (sent, method, url, fails = true) => {
  const m = String(method).toUpperCase();
  if (ours(url)) {
    const named = m + ' ' + recordedUrl(String(url));
    note('T ' + named);
    if (fails) sent.push(named);
    return named;
  }
  note('O ' + m + ' ' + originOf(url));
  return m + ' ' + originOf(url);
};
const failure = (named) => new Error('The write guard blocked ' + named + ': validation sends no writes unless the run allows them (--allow-mutations).');
/** A beacon (sendBeacon, <a ping>) or a CSP report: the page sends it on its own, so it is aborted and logged, and fails no test. */
const SENT_ON_ITS_OWN = new Set(['Ping', 'CSPViolationReport']);
const SENDS = { post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE' };
/** An API request context that refuses writes; reads, and everything else, go to it unchanged. */
const guardedRequest = (ctx, sent) => new Proxy(ctx, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    // bound to the context itself, so a read's own fetch() inside Playwright is not checked (and keeps its call name)
    if (!(Object.hasOwn(SENDS, key) || key === 'fetch' || key === '_innerFetch')) return value.bind(target);
    return (...args) => {
      let method, url;
      if (key === '_innerFetch') { // route.fetch() calls it on the context's request
        const o = args[0] ?? {};
        method = o.method || o.request?.method() || 'GET';
        url = o.url ?? o.request?.url();
      } else {
        const req = typeof args[0] === 'string' ? undefined : args[0];
        method = key === 'fetch' ? (args[1]?.method ?? req?.method?.() ?? 'GET') : SENDS[key];
        url = req?.url ? req.url() : String(args[0]);
      }
      if (changesServer(method)) return Promise.reject(failure(block(sent, method, url)));
      // called as a method: Playwright names the call in its errors after the frame that made it (not \`apply\`)
      return target[key](...args);
    };
  },
});
/** What this worker blocked on a guarded origin since its current test began. */
const SENT = [];
const norm = (s) => String(s).split(String.fromCharCode(92)).join('/').toLowerCase();
const SELF = norm(__filename);
const FLOWS_FIXTURE = ${JSON.stringify(flowsFixture.split("\\").join("/").toLowerCase())};
/**
 * The API flows fixture's sign-in (#230) sends its login POST by design: a context made by that function of that file
 * is the one that stays unguarded. Every other caller (a spec, a helper, the fixture's data flows) gets a guarded one.
 */
const signInOfFlows = () => {
  const caller = String(new Error().stack).split('\\n').slice(1).find((l) => !norm(l).includes(SELF));
  return caller !== undefined && /\\bat (?:async )?signIn \\(/.test(caller) && norm(caller).includes(FLOWS_FIXTURE);
};
// One object: the export \`request\`, the \`playwright\` fixture's \`playwright.request\` and the one the request fixture uses.
const newContext = pw.request.newContext.bind(pw.request);
pw.request.newContext = (...args) => {
  const exempt = signInOfFlows();
  return newContext(...args).then((ctx) => (exempt ? ctx : guardedRequest(ctx, SENT)));
};
const test = pw.test.extend({
  cairnWriteGuard: [async ({ browser }, use, workerInfo) => {
    const sent = SENT;
    const cdp = await browser.newBrowserCDPSession();
    cdp.on('Fetch.requestPaused', ({ requestId, request, resourceType }) => {
      if (!changesServer(request.method)) {
        cdp.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
        return;
      }
      block(sent, request.method, request.url, !SENT_ON_ITS_OWN.has(resourceType));
      // "Aborted" (net::ERR_ABORTED): a stopped form post leaves the page where it was, with no error page over it
      cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => undefined);
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    note('W ' + workerInfo.workerIndex);
    await use(sent);
  }, { scope: 'worker', auto: true }],
  cairnWriteCheck: [async ({ cairnWriteGuard }, use) => {
    cairnWriteGuard.length = 0;
    await use();
    const mine = [...new Set(cairnWriteGuard.splice(0))];
    if (mine.length > 0) throw failure(mine.join(', '));
  }, { auto: true }],
  request: async ({ request, cairnWriteGuard }, use) => {
    await use(guardedRequest(request, cairnWriteGuard));
  },
  // A page takes its context's request when it opens (page.request), and route.fetch() goes through it too.
  context: async ({ context, cairnWriteGuard }, use) => {
    context.request = guardedRequest(context.request, cairnWriteGuard);
    await use(context);
  },
});
const unguarded = (type) => new Proxy(type, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof key === 'string' && /^(launch|connect)/.test(key)) {
      return () => Promise.reject(new Error('The write guard refuses ' + target.name() + '.' + key + '() in validation: a browser of the spec\\'s own would send writes unchecked. Use the page and context fixtures.'));
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
Object.defineProperty(exports, '__esModule', { value: true });
${exportNames(pwTest).map((k) => `exports.${k} = pw.${k};`).join("\n")}
exports.chromium = unguarded(pw.chromium);
exports.firefox = unguarded(pw.firefox);
exports.webkit = unguarded(pw.webkit);
exports.test = test;
exports.default = test;
`;
}

/**
 * `@playwright/test`'s own export names, each written out: a spec run as an ES module finds a CommonJS module's names
 * only where they stand as `exports.name =`.
 */
function exportNames(pwTest: string): string[] {
  const own = new Set(["test", "default", "chromium", "firefox", "webkit"]);
  return Object.keys(createRequire(import.meta.url)(pwTest) as object).filter((k) => !own.has(k) && /^[A-Za-z_$][\w$]*$/.test(k));
}

/** What a validation run's guard saw. */
export interface GuardRecord {
  /** Each write blocked on a guarded origin, `METHOD url` as a report shows a URL, once. */
  blocked: string[];
  /** Writes aborted on any other origin: by origin, the methods and how many. */
  otherOrigins: Map<string, { methods: Set<string>; count: number }>;
  /** The workers (Playwright's `workerIndex`) the guard loaded in. */
  workers: Set<number>;
}

export interface InstalledGuard {
  /** The tsconfig the run's Playwright config names. */
  tsconfig: string;
  /** What the run's guard saw; its log is gone after. */
  read(): Promise<GuardRecord>;
}

/** Write the guard into the run (`runDir` absolute); `origins` empty guards every origin. */
export async function installWriteGuard(runDir: string, origins: string[], pwTest: string): Promise<InstalledGuard> {
  const module = join(runDir, "write-guard.cjs");
  const tsconfig = join(runDir, "write-guard.tsconfig.json");
  const log = join(runDir, "write-guard.log");
  await rm(log, { force: true });
  const guarded = [...new Set(origins.map((o) => new URL(o).origin))];
  await writeFile(module, guardModule(pwTest, guarded, log, join(runDir, "tests", FLOW_FIXTURE_FILE)), "utf8");
  // Exact keys: Playwright maps only these specifiers, and never inside node_modules, so the guard's own require stays real.
  // The guard exports all that \`playwright\` and \`playwright-core\` do, so a spec that takes its browser types there gets it too.
  const paths = Object.fromEntries(["@playwright/test", "playwright/test", "playwright", "playwright-core"].map((k) => [k, [module]]));
  await writeFile(tsconfig, JSON.stringify({ compilerOptions: { allowJs: true, paths } }, null, 2), "utf8");
  return {
    tsconfig,
    read: async () => {
      const text = await readFile(log, "utf8").catch(() => "");
      await rm(log, { force: true });
      const record: GuardRecord = { blocked: [], otherOrigins: new Map(), workers: new Set() };
      for (const line of text.split("\n")) {
        const [kind, method = "", at = ""] = line.split(" ");
        if (kind === "W") record.workers.add(Number(method));
        else if (kind === "T" && !record.blocked.includes(`${method} ${at}`)) record.blocked.push(`${method} ${at}`);
        else if (kind === "O") {
          const seen = record.otherOrigins.get(at) ?? { methods: new Set<string>(), count: 0 };
          seen.methods.add(method);
          seen.count += 1;
          record.otherOrigins.set(at, seen);
        }
      }
      return record;
    },
  };
}
