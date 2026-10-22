import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { HttpCredentials } from "../browser/index.js";
import { EnvironmentConfigError } from "./errors.js";
import { basicAuthSecrets } from "./redact.js";

type EnvRecord = Record<string, string | undefined>;

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** NAME of an environment variable — never its value. A value-looking string is rejected without being echoed. */
const VarName = z.string().regex(VAR_NAME, "must be the NAME of an environment variable (letters, digits, _), not a value");
const Path = z.string().min(1).startsWith("/", "must start with /");

const CredentialVars = z.object({ usernameVar: VarName, passwordVar: VarName }).strict();

/**
 * The environment description (a JSON file and/or CAIRN_ENV_* variables). Secrets are never in it: it only
 * NAMES the variables that hold them. `.strict()` turns a stray `password` / `token` key into an error.
 */
export const EnvironmentSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((u) => {
        const p = new URL(u);
        return !p.username && !p.password;
      }, "must not contain credentials — use basicAuth with environment variable names"),
    basicAuth: CredentialVars.optional(),
    user: CredentialVars.extend({
      loginPath: Path.default("/login"),
      usernameLabel: z.string().min(1).optional(),
      passwordLabel: z.string().min(1).optional(),
      submitLabel: z.string().min(1).optional(),
    })
      .strict()
      .optional(),
    startPath: Path.optional(),
  })
  .strict();
export type Environment = z.infer<typeof EnvironmentSchema>;

/** CAIRN_ENV_* variables that override / complete the file. */
const OVERLAY: Record<string, (env: Record<string, unknown>, v: string) => void> = {
  CAIRN_ENV_BASE_URL: (e, v) => (e.baseUrl = v),
  CAIRN_ENV_START_PATH: (e, v) => (e.startPath = v),
  CAIRN_ENV_BASIC_AUTH_USER_VAR: (e, v) => (sub(e, "basicAuth").usernameVar = v),
  CAIRN_ENV_BASIC_AUTH_PASSWORD_VAR: (e, v) => (sub(e, "basicAuth").passwordVar = v),
  CAIRN_ENV_USER_VAR: (e, v) => (sub(e, "user").usernameVar = v),
  CAIRN_ENV_PASSWORD_VAR: (e, v) => (sub(e, "user").passwordVar = v),
  CAIRN_ENV_LOGIN_PATH: (e, v) => (sub(e, "user").loginPath = v),
};

function sub(e: Record<string, unknown>, key: string): Record<string, unknown> {
  const cur = e[key];
  if (cur && typeof cur === "object") return cur as Record<string, unknown>;
  const fresh: Record<string, unknown> = {};
  e[key] = fresh;
  return fresh;
}

/** Validates a raw description. Issue text names the path and the rule, never the offending value. */
export function parseEnvironment(raw: unknown, source = "environment"): Environment {
  const r = EnvironmentSchema.safeParse(raw);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => {
    const where = i.path.join(".") || "(root)";
    if (i.code === "unrecognized_keys") {
      return `${where}: unknown key(s) ${i.keys.map((k) => `"${k}"`).join(", ")} — secrets never go in this file; name the environment variable that holds them (usernameVar / passwordVar)`;
    }
    return `${where}: ${i.message}`;
  });
  throw new EnvironmentConfigError(`Invalid ${source}:\n  ${lines.join("\n  ")}`);
}

export interface LoadEnvironmentOptions {
  /** Path of the JSON description (CLI `--env-file`); falls back to CAIRN_ENV_FILE. */
  file?: string;
  env?: EnvRecord;
}

/**
 * Loads the environment description: the file (if any), then CAIRN_ENV_* overrides. Returns undefined when
 * neither is present — the run then behaves exactly as before this feature existed.
 */
export async function loadEnvironment(opts: LoadEnvironmentOptions = {}): Promise<Environment | undefined> {
  const env = opts.env ?? process.env;
  const file = opts.file ?? env.CAIRN_ENV_FILE;
  let raw: Record<string, unknown> = {};
  if (file) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new EnvironmentConfigError(`Cannot read the environment file "${file}".`);
    }
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    } catch {
      throw new EnvironmentConfigError(`The environment file "${file}" is not valid JSON.`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new EnvironmentConfigError(`The environment file "${file}" must contain a JSON object.`);
    }
  }
  let overlaid = false;
  for (const [name, apply] of Object.entries(OVERLAY)) {
    const v = env[name];
    if (v !== undefined && v !== "") {
      apply(raw, v);
      overlaid = true;
    }
  }
  if (!file && !overlaid) return undefined;
  return parseEnvironment(raw, file ? `environment (${file})` : "environment (CAIRN_ENV_* variables)");
}

export interface ResolvedEnvironment {
  environment: Environment;
  basicAuth?: HttpCredentials;
  login?: HttpCredentials;
  /** Every secret value of this environment (and derived forms) — fed to the redactor. */
  secrets: string[];
}

function read(env: EnvRecord, name: string, what: string): string {
  const v = env[name];
  if (v === undefined || v === "") {
    throw new EnvironmentConfigError(`Environment variable ${name} (${what}) is not set.`);
  }
  return v;
}

/** Reads the secrets from the process environment. A missing variable is named; no value is ever printed. */
export function resolveEnvironment(environment: Environment, env: EnvRecord = process.env): ResolvedEnvironment {
  const secrets: string[] = [];
  let basicAuth: HttpCredentials | undefined;
  let login: HttpCredentials | undefined;
  if (environment.basicAuth) {
    const { usernameVar, passwordVar } = environment.basicAuth;
    basicAuth = {
      username: read(env, usernameVar, "Basic Auth login"),
      password: read(env, passwordVar, "Basic Auth password"),
    };
    secrets.push(...basicAuthSecrets(basicAuth.username, basicAuth.password), basicAuth.username);
  }
  if (environment.user) {
    const { usernameVar, passwordVar } = environment.user;
    login = {
      username: read(env, usernameVar, "login"),
      password: read(env, passwordVar, "password"),
    };
    secrets.push(login.password, login.username);
  }
  return { environment, basicAuth, login, secrets };
}
