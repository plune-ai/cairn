import { describe, it, expect, afterEach } from "vitest";
import { applyEnvironment } from "../../src/environment/apply.js";
import { parseEnvironment } from "../../src/environment/config.js";
import { BasicAuthRejectedError, LoginFailedError, StartPageUnreachableError } from "../../src/environment/errors.js";
import { startEnvApp, type EnvApp, type EnvAppOptions } from "../fixtures/env-app.js";

const SECRETS = { BASIC_U: "stage", BASIC_P: "Basic-Sup3r-Pass", APP_U: "qa@example.com", APP_P: "App-Sup3r-Pass" };
const FULL: EnvAppOptions = {
  basic: { user: SECRETS.BASIC_U, pass: SECRETS.BASIC_P },
  login: { user: SECRETS.APP_U, pass: SECRETS.APP_P },
};
const BASIC = { basicAuth: { usernameVar: "BASIC_U", passwordVar: "BASIC_P" } };
const USER = { user: { usernameVar: "APP_U", passwordVar: "APP_P" } };

let app: EnvApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const describeEnv = (baseUrl: string, parts: Record<string, unknown>) => parseEnvironment({ baseUrl, ...parts });

async function run(opts: EnvAppOptions, parts: Record<string, unknown>, processEnv: Record<string, string> = SECRETS) {
  await app?.close();
  app = await startEnvApp(opts);
  const events: string[] = [];
  const applied = await applyEnvironment(describeEnv(app.url, parts), { processEnv, onProgress: (e) => events.push(e) });
  return { applied, events, log: app.log };
}

const stageOf = (e: string): string => e.split(":")[0]!;

describe("environment: fixed order Basic Auth → login → startPath (real Chromium, fake app)", () => {
  it("runs the stages in order — verified on the server and in the progress events", async () => {
    const { applied, events, log } = await run(FULL, { ...BASIC, ...USER, startPath: "/start" });
    const first = (needle: string): number => log.findIndex((l) => l.startsWith(needle));
    expect(log[0]).toBe("GET /"); // Basic Auth is checked before anything else
    expect(first("GET /login")).toBeGreaterThan(0);
    expect(first("POST /login")).toBeGreaterThan(first("GET /login"));
    expect(first("GET /start")).toBeGreaterThan(first("POST /login"));
    expect(events.map(stageOf)).toEqual(["environment basic-auth", "environment login", "environment start-path"]);
    expect(applied.startUrl).toBe(`${app!.url}/start`);
    expect(applied.storageState?.cookies.some((c) => c.name === "sid")).toBe(true);
  }, 60_000);

  it("skips stages whose input is absent", async () => {
    // no basicAuth, no user: only the start path is visited
    let r = await run({}, { startPath: "/start" });
    expect(r.log).toEqual(["GET /start"]);
    expect(r.events.map(stageOf)).toEqual(["environment basic-auth", "environment login", "environment start-path"]);
    expect(r.events[0]).toContain("skipped");
    expect(r.events[1]).toContain("skipped");
    expect(r.applied.storageState).toBeUndefined();

    // user only: login, no start path
    r = await run({ login: FULL.login }, { ...USER });
    expect(r.log).toEqual(["GET /login", "POST /login", "GET /home"]);
    expect(r.events[0]).toContain("skipped");
    expect(r.events[2]).toContain("skipped");

    // basicAuth only: one probe, no browser stages
    r = await run({ basic: FULL.basic }, { ...BASIC });
    expect(r.log).toEqual(["GET /"]);
    expect(r.applied.storageState).toBeUndefined();
  }, 90_000);

  it("reports the three failures with three different messages", async () => {
    const messages: string[] = [];
    app = await startEnvApp(FULL);
    const parts = { ...BASIC, ...USER, startPath: "/start" };

    await expect(
      applyEnvironment(describeEnv(app.url, parts), { processEnv: { ...SECRETS, BASIC_P: "wrong" } }),
    ).rejects.toSatisfy((e: Error) => {
      messages.push(e.message);
      return e instanceof BasicAuthRejectedError && /Basic Auth rejected/.test(e.message);
    });

    await expect(
      applyEnvironment(describeEnv(app.url, parts), { processEnv: { ...SECRETS, APP_P: "wrong" } }),
    ).rejects.toSatisfy((e: Error) => {
      messages.push(e.message);
      return e instanceof LoginFailedError && /Login failed/.test(e.message);
    });

    await expect(
      applyEnvironment(describeEnv(app.url, { ...BASIC, ...USER, startPath: "/missing" }), { processEnv: SECRETS }),
    ).rejects.toSatisfy((e: Error) => {
      messages.push(e.message);
      return e instanceof StartPageUnreachableError && /Start page unreachable/.test(e.message);
    });

    expect(new Set(messages.map((m) => m.split(":")[0])).size).toBe(3);
  }, 90_000);

  it("never leaks a secret into progress events or error messages", async () => {
    const all: string[] = [];
    const { events } = await run(FULL, { ...BASIC, ...USER, startPath: "/start" });
    all.push(...events);
    for (const bad of [{ BASIC_P: "wrong-basic-Pass" }, { APP_P: "wrong-app-Pass" }]) {
      await applyEnvironment(describeEnv(app!.url, { ...BASIC, ...USER, startPath: "/start" }), {
        processEnv: { ...SECRETS, ...bad },
        onProgress: (e) => all.push(e),
      }).catch((e: Error) => all.push(e.message));
    }
    const text = all.join("\n");
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [...Object.values(SECRETS), "wrong-basic-Pass", "wrong-app-Pass"]) {
      expect(text).not.toContain(secret);
    }
  }, 90_000);
});
