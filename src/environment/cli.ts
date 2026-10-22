import { loadEnvironment, type Environment } from "./config.js";
import { startUrlOf } from "./apply.js";
import { EnvironmentConfigError } from "./errors.js";

/** `--env-file` help, shared by explore / design / automate. */
export const ENV_FILE_HELP =
  "environment description (JSON): baseUrl, basicAuth, user, startPath — Basic Auth → login → start path before the run; secrets come from the environment variables it names (also CAIRN_ENV_FILE / CAIRN_ENV_*)";

/**
 * Resolves the page a run explores and the environment to apply first. An explicit `--url` wins; otherwise the
 * environment's start URL is used. Neither a flag nor a description ⇒ the same "required" error as before.
 */
export async function environmentForRun(opts: {
  url?: string;
  envFile?: string;
}): Promise<{ url: string; environment?: Environment }> {
  const environment = await loadEnvironment({ file: opts.envFile });
  const url = opts.url ?? (environment ? startUrlOf(environment) : undefined);
  if (!url) throw new EnvironmentConfigError("required option '--url <url>' not specified (or give --env-file with a baseUrl)");
  return { url, environment };
}
