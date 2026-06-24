import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BOT_VERSION } from "../index.js";
import { TOOL_INPUT_SHAPE, ToolInputSchema, exploreTool, designTool } from "./tools.js";

/**
 * Build the Cairn MCP server (#49): exposes `explore` and `design` as tools over the shared core.
 * Separated from {@link startMcpServer} so a smoke test can introspect tools without a transport.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "cairn", version: BOT_VERSION });

  server.registerTool(
    "explore",
    {
      title: "Generate UI test cases + code (explore)",
      description:
        "Explore a web page and generate methodology-based UI test cases, @playwright/test code, and a " +
        "validate⇄repair report. Returns the cases, validation summary, metrics, the Pilot verdict, cost, " +
        "and the run directory. Use `flow`+`setup` for multi-page journeys; `session` for authenticated targets.",
      inputSchema: TOOL_INPUT_SHAPE,
    },
    async (args) => {
      const result = await exploreTool(ToolInputSchema.parse(args));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "design",
    {
      title: "Design UI test cases, no code (design)",
      description:
        "Explore a web page and design methodology-based UI test cases in ATC/MTC format (markdown + " +
        "selectors) WITHOUT generating or running code. Returns the cases, metrics, cost, and the run " +
        "directory. The cheaper first step before `explore`/automate.",
      inputSchema: TOOL_INPUT_SHAPE,
    },
    async (args) => {
      const result = await designTool(ToolInputSchema.parse(args));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}

/** Start the Cairn MCP server over stdio — the entry point `cairn mcp` drives. */
export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
