// A stdio MCP server for the MCP lint step (scripts/mcp-self-lint.mjs), written as plain JSON-RPC so no SDK corrects
// what it sends. The mode is argv[2]:
// - `broken`: two tools named `explore`, and an input schema whose type is not `object`;
// - `free-string`: one tool whose `decider` is a free string that lists its values in the description;
// - `empty`: a healthy server with an empty tools/list;
// - `crash`: exits before it reads anything.

import { createInterface } from "node:readline";

const mode = process.argv[2];
if (mode === "crash") process.exit(1);

const object = (properties = {}) => ({ type: "object", properties, additionalProperties: false });
const TOOLS = {
  broken: [
    { name: "explore", description: "Explores a web application and writes a report.", inputSchema: object() },
    { name: "explore", description: "Explores it again.", inputSchema: object() },
    { name: "design", description: "Designs test cases.", inputSchema: { type: "string" } },
  ],
  "free-string": [
    {
      name: "explore",
      description: "Explores a web application and writes a report of what it found.",
      inputSchema: object({
        decider: { type: "string", description: "The decision layer. One of: off, laya, jev." },
      }),
    },
  ],
  empty: [],
}[mode];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

function answer({ id, method, params = {} }) {
  if (method === "initialize") {
    const version = ["2025-11-25", "2025-06-18"].includes(params.protocolVersion) ? params.protocolVersion : "2025-11-25";
    return send({ id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: `self-lint-${mode}`, version: "1.0.0" } } });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
  return send({ id, error: { code: -32601, message: "Method not found" } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && msg.method !== undefined) answer(msg);
});
lines.on("close", () => process.exit(0));
