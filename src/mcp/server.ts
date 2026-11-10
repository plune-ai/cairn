import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BOT_VERSION } from "../index.js";
import {
  TOOL_INPUT_SHAPE,
  ToolInputSchema,
  AUTOMATE_INPUT_SHAPE,
  AutomateInputSchema,
  ExploreToolResultSchema,
  DesignToolResultSchema,
  AutomateToolResultSchema,
  exploreTool,
  designTool,
  automateTool,
  defaultDeps,
  type ToolDeps,
} from "./tools.js";

/**
 * The result as the client gets it: JSON text (for clients that read only text) and the same object as
 * `structuredContent`. Parsing drops keys the output schema does not name, which a client would reject.
 * The work is already done (and paid) when this runs, so a result that fails its schema is an error that
 * still names the run folder, never a lost run.
 */
function toolResult<T extends Record<string, unknown>>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { message: string } } },
  result: unknown,
) {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    const runDir = (result as { runDir?: unknown } | null)?.runDir;
    const where = typeof runDir === "string" ? ` The run finished; its files are in ${runDir}.` : "";
    return { isError: true, content: [{ type: "text" as const, text: `The result did not match the tool's output schema: ${parsed.error.message}.${where}` }] };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(parsed.data, null, 2) }], structuredContent: parsed.data };
}

/**
 * Build the Cairn MCP server (#49): exposes `explore`, `design` and `automate` as tools over the shared core.
 * Separated from {@link startMcpServer} so a test can introspect and call the tools without a transport.
 *
 * The annotations are hints a client may show or act on, not a guarantee; each is set from what the core does.
 * Every tool writes files and calls models (and explore/design open the target URL), so none is read-only and
 * all reach an open world.
 */
export function buildMcpServer(deps: ToolDeps = defaultDeps): McpServer {
  const server = new McpServer({ name: "cairn", version: BOT_VERSION });

  server.registerTool(
    "explore",
    {
      title: "Generate UI test cases + code (explore)",
      description:
        "Explore a web page and generate methodology-based UI test cases, @playwright/test code, and a " +
        "validate⇄repair report. Returns the cases, validation summary, metrics, the Pilot verdict, cost, " +
        "and the run directory. Use `flow`+`setup` for multi-page journeys; `session` for authenticated targets. " +
        "Each call is paid (model calls), runs the tests it writes against the page, and creates a new runs/<id>/ folder; " +
        "with `intoProject` it also adds spec files to the project's testDir, never overwriting one that exists.",
      inputSchema: TOOL_INPUT_SHAPE,
      outputSchema: ExploreToolResultSchema,
      // Not destructive: each call writes a new runs/<uuid>/ (runExploration: randomUUID), and `intoProject` renames
      // its own file on a clash instead of overwriting (ejectSuiteToProject). Not idempotent: every call is a new run.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => toolResult(ExploreToolResultSchema, await exploreTool(ToolInputSchema.parse(args), deps)),
  );

  server.registerTool(
    "design",
    {
      title: "Design UI test cases, no code (design)",
      description:
        "Explore a web page and design methodology-based UI test cases in ATC/MTC format (markdown + " +
        "selectors) WITHOUT generating or running code. Returns the cases, metrics, cost, and the run " +
        "directory. The cheaper first step before `explore`/automate. " +
        "Each call is paid (model calls) and creates a new runs/<id>/ folder.",
      inputSchema: TOOL_INPUT_SHAPE,
      outputSchema: DesignToolResultSchema,
      // Not destructive: it writes only a new runs/<uuid>/ (runDesign: randomUUID). Not idempotent: a new run per call.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => toolResult(DesignToolResultSchema, await designTool(ToolInputSchema.parse(args), deps)),
  );

  server.registerTool(
    "automate",
    {
      title: "Generate @playwright/test from ready cases (automate)",
      description:
        "Generate @playwright/test code from the ready ATC cases of a previous run (the second half of " +
        "the decoupled design → automate flow). Pass `run` = the run id/dir returned by `design`; " +
        "optionally `validate` (needs a `session`). Returns the spec files, validation summary, and cost — " +
        "plus `decider` (and, when any, `notRepaired` and `healed`) when an active decision layer ran. " +
        "Each call is paid (model calls) and replaces the tests/ folder of that run; `validate` runs the new " +
        "tests against the target site, and `intoProject` adds the specs to the project's testDir instead.",
      inputSchema: AUTOMATE_INPUT_SHAPE,
      outputSchema: AutomateToolResultSchema,
      // Destructive: it writes into an existing run, and writeSuite empties that run's tests/ first (with `intoProject`
      // the run's tests/ is removed). Not idempotent: codegen differs per call, and `intoProject` adds renamed copies.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => toolResult(AutomateToolResultSchema, await automateTool(AutomateInputSchema.parse(args), deps)),
  );

  return server;
}

/** Start the Cairn MCP server over stdio — the entry point `cairn mcp` drives. */
export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
