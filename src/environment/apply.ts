/**
 * Applies an environment description in one fixed order — Basic Auth → login → startPath — and stops at the first
 * stage that fails, with a message that names the stage. A stage whose input is absent is skipped (and logged so).
 * Browser work uses its own lib gateway (the only backend that owns a context, ADR-0003); the resulting session
 * is handed to the run's gateway and to the validation runner.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGateway } from "../browser/index.js";
import type { BrowserGateway, HttpCredentials, StorageState } from "../browser/index.js";
import { parseAriaSnapshot } from "../observe/parse-aria.js";
import { resolveEnvironment, type Environment, type ResolvedEnvironment } from "./config.js";
import { BasicAuthRejectedError, LoginFailedError, StartPageUnreachableError } from "./errors.js";
import { redact } from "./redact.js";

type EnvRecord = Record<string, string | undefined>;

export interface ApplyOptions {
  processEnv?: EnvRecord;
  /** Progress sink. Every message is redacted before it gets here. */
  onProgress?: (event: string) => void;
  headless?: boolean;
  channel?: string;
  /** A saved session was supplied (`--session*`): the login stage is skipped, the session stays in charge. */
  skipLogin?: boolean;
}

export interface AppliedEnvironment {
  /** Where the run starts: baseUrl + startPath (or baseUrl alone). */
  startUrl: string;
  /** Session after the login stage (absent when login was skipped). */
  storageState?: StorageState;
  /** Basic Auth values for the browser context. */
  httpCredentials?: HttpCredentials;
  /** Names of the variables holding Basic Auth — for the generated Playwright config, which reads process.env itself. */
  httpCredentialsEnv?: { usernameVar: string; passwordVar: string };
  /** Secret values of this environment, for redacting everything else the run writes. */
  secrets: string[];
}

const USER_LABEL = /user|e-?mail|login|логін|пошта/i;
const PASS_LABEL = /pass|парол/i;
const SUBMIT_LABEL = /sign.?in|log.?in|submit|continue|увійти|вхід|ввійти/i;

const join_ = (base: string, path: string): string => new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();

/** baseUrl + startPath (or baseUrl alone) — where a run starts. */
export function startUrlOf(environment: Environment): string {
  return environment.startPath ? join_(environment.baseUrl, environment.startPath) : environment.baseUrl;
}
const origin = (u: string): string => new URL(u).origin;

function matcher(label: string | undefined, fallback: RegExp): (name: string | undefined) => boolean {
  if (!label) return (n) => fallback.test(n ?? "");
  const want = label.toLowerCase();
  return (n) => (n ?? "").toLowerCase().includes(want);
}

export async function applyEnvironment(environment: Environment, opts: ApplyOptions = {}): Promise<AppliedEnvironment> {
  const resolved = resolveEnvironment(environment, opts.processEnv ?? process.env);
  const { secrets } = resolved;
  const log = (stage: string, msg: string): void => opts.onProgress?.(redact(`environment ${stage}: ${msg}`, secrets));
  const fail = <E extends Error>(make: (m: string) => E, msg: string): never => {
    throw make(redact(msg, secrets));
  };

  const base = environment.baseUrl;
  const startUrl = startUrlOf(environment);
  const doLogin = Boolean(resolved.login) && !opts.skipLogin;

  // 1 — Basic Auth: one request that proves the credentials before any browser time is spent.
  if (resolved.basicAuth) {
    await probeBasicAuth(base, resolved, fail);
    log("basic-auth", `accepted by ${origin(base)}`);
  } else {
    log("basic-auth", "skipped (no basicAuth)");
  }

  let storageState: StorageState | undefined;
  const needsBrowser = doLogin || Boolean(environment.startPath);
  if (needsBrowser) {
    const gateway = makeGateway({
      backend: "lib",
      headless: opts.headless ?? true,
      channel: opts.channel,
      httpCredentials: resolved.basicAuth,
    });
    try {
      // 2 — login with the user from the environment variables.
      if (doLogin) {
        await login(gateway, environment, resolved, fail);
        log("login", `signed in via ${environment.user!.loginPath}`);
        storageState = await gateway.session().save();
      } else {
        log("login", opts.skipLogin && resolved.login ? "skipped (a saved session was supplied)" : "skipped (no user)");
      }
      // 3 — the start path.
      if (environment.startPath) {
        await openStart(gateway, startUrl, Boolean(resolved.basicAuth), fail);
        log("start-path", `reached ${startUrl}`);
      } else {
        log("start-path", "skipped (no startPath)");
      }
    } finally {
      await gateway.close();
    }
  } else {
    log("login", opts.skipLogin && resolved.login ? "skipped (a saved session was supplied)" : "skipped (no user)");
    log("start-path", "skipped (no startPath)");
  }

  return {
    startUrl,
    storageState,
    httpCredentials: resolved.basicAuth,
    httpCredentialsEnv: environment.basicAuth,
    secrets,
  };
}

type Fail = <E extends Error>(make: (m: string) => E, msg: string) => never;

async function probeBasicAuth(base: string, r: ResolvedEnvironment, fail: Fail): Promise<void> {
  const { username, password } = r.basicAuth!;
  const vars = r.environment.basicAuth!;
  let status: number;
  try {
    const res = await fetch(base, {
      redirect: "manual",
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
  } catch (e) {
    return fail((m) => new StartPageUnreachableError(m), `Start page unreachable: ${origin(base)} did not answer (${(e as Error).message}).`);
  }
  if (status === 401) {
    fail(
      (m) => new BasicAuthRejectedError(m),
      `Basic Auth rejected: ${origin(base)} answered 401 to the credentials from $${vars.usernameVar} / $${vars.passwordVar}. Check the values of those variables.`,
    );
  }
}

async function login(gateway: BrowserGateway, env: Environment, r: ResolvedEnvironment, fail: Fail): Promise<void> {
  const user = env.user!;
  const loginUrl = join_(env.baseUrl, user.loginPath);
  const failure = (why: string): never =>
    fail(
      (m) => new LoginFailedError(m),
      `Login failed: ${why} (login page ${loginUrl}, user from $${user.usernameVar} / $${user.passwordVar}).`,
    );

  let obs;
  try {
    obs = await gateway.observe({ url: loginUrl });
  } catch (e) {
    return failure(`the login page could not be opened: ${(e as Error).message}`);
  }
  if (obs.status === 401 && r.basicAuth) {
    return fail(
      (m) => new BasicAuthRejectedError(m),
      `Basic Auth rejected: ${origin(env.baseUrl)} answered 401 in the browser to the credentials from $${env.basicAuth!.usernameVar} / $${env.basicAuth!.passwordVar}.`,
    );
  }
  if (obs.status !== undefined && obs.status >= 400) return failure(`the login page answered HTTP ${obs.status}`);

  const isUser = matcher(user.usernameLabel, USER_LABEL);
  const isPass = matcher(user.passwordLabel, PASS_LABEL);
  const isSubmit = matcher(user.submitLabel, SUBMIT_LABEL);
  const els = parseAriaSnapshot(obs.ariaSnapshot);
  const boxes = els.filter((e) => e.role === "textbox" || e.role === "searchbox");
  const passBox = boxes.find((e) => isPass(e.name));
  const userBox = boxes.find((e) => e !== passBox && isUser(e.name)) ?? boxes.find((e) => e !== passBox);
  const submit = els.find((e) => e.role === "button" && isSubmit(e.name)) ?? els.find((e) => e.role === "button");
  if (!userBox || !passBox || !submit) {
    return failure("no login form found (need a login field, a password field and a button)");
  }

  for (const step of [
    { kind: "fill" as const, ref: userBox.ref, value: r.login!.username },
    { kind: "fill" as const, ref: passBox.ref, value: r.login!.password },
    { kind: "click" as const, ref: submit.ref },
  ]) {
    const res = await gateway.act(step);
    if (!res.ok) return failure(`the form could not be filled in: ${res.error ?? "unknown error"}`);
  }

  const after = await gateway.observe({});
  const stillForm = parseAriaSnapshot(after.ariaSnapshot).some((e) => e.role === "textbox" && isPass(e.name));
  if (stillForm) return failure("the login form is still shown after submitting — the credentials were not accepted");
}

async function openStart(gateway: BrowserGateway, startUrl: string, hasBasic: boolean, fail: Fail): Promise<void> {
  let status: number | undefined;
  try {
    status = (await gateway.observe({ url: startUrl })).status;
  } catch (e) {
    return fail((m) => new StartPageUnreachableError(m), `Start page unreachable: ${startUrl} could not be opened (${(e as Error).message}).`);
  }
  if (status === 401 && hasBasic) {
    return fail((m) => new BasicAuthRejectedError(m), `Basic Auth rejected: ${startUrl} answered 401 in the browser.`);
  }
  if (status !== undefined && status >= 400) {
    return fail((m) => new StartPageUnreachableError(m), `Start page unreachable: ${startUrl} answered HTTP ${status}.`);
  }
}

/**
 * Writes a session to a private temp file for the validation runner (`use.storageState`) and removes it when the
 * process exits. The file holds session cookies, so it never goes into the run dir (which gets uploaded as an artifact).
 */
export function writeTempSession(state: StorageState): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-env-session-"));
  const file = join(dir, "session.storageState.json");
  writeFileSync(file, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });
  return file;
}
