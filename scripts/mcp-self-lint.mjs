#!/usr/bin/env node
// The MCP lint step of CI (ci.yml and mcp-self-lint-report.yml): `plune mcp lint` from the published plune CLI, pinned
// here, against the server the arguments name, its JUnit written to <report-dir>/lint.xml.
//
//   node scripts/mcp-self-lint.mjs <report-dir> -- <server command>
//
// The exit code is the lint's: 1 a finding at the error level, 2 the server did not start, 3 nothing measured, such as
// an empty tool list. A heuristic finding (a free string whose description lists its values, say) is printed and does
// not fail. No model is called: the step refuses to run while a provider key is set, and the server gets no variable
// (the lint passes on only those named with --env, none here). No tool is called (no --call).

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const PLUNE_CLI = "@plune-ai/cli@0.34.6";

const [dir, ...server] = process.argv.slice(2);
if (!dir || server[0] !== "--" || server.length < 2) {
  console.error("usage: node scripts/mcp-self-lint.mjs <report-dir> -- <server command>");
  process.exit(2);
}

const keys = Object.keys(process.env).filter((name) => /_API_KEY$/i.test(name));
if (keys.length > 0) {
  console.error(`A model provider key is set in this step: this check must not reach a model (${keys.join(", ")}).`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
const started = Date.now();
// npx is a .cmd file on Windows, which only a shell runs, and a shell splits a path with spaces (C:\Program Files):
// there, npm's own npx script runs under this node instead.
const npx =
  process.platform === "win32"
    ? [process.execPath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")]
    : ["npx"];
const lint = ["-y", PLUNE_CLI, "mcp", "lint", "--reporter", "junit-xml", "--out", join(dir, "lint.xml"), ...server];
const r = spawnSync(npx[0], [...npx.slice(1), ...lint], { stdio: "inherit" });
const code = r.status ?? 1;
console.log(`plune mcp lint: exit ${code}, ${Date.now() - started} ms`);
process.exit(code);
