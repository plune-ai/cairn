#!/usr/bin/env node
/**
 * Deprecated `lex-bot` CLI alias (C0-03). Prints a one-line deprecation notice to
 * stderr, then runs the exact same code path as `cairn`. Kept for 1–2 releases so
 * existing scripts/aliases keep working; will be removed once users have migrated.
 */
import { LEXBOT_CLI_NOTICE } from "./branding.js";
import { runCli } from "./index.js";

process.stderr.write(`${LEXBOT_CLI_NOTICE}\n`);
await runCli();
