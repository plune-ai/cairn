/**
 * MCP-E1 — the `mcp-test` modality: read a foreign MCP server and write its model (`mcp-model.json`).
 * Generation and tool calls come in later slices; here the command only connects, lists and records.
 * (`cairn mcp` is the opposite direction — Cairn itself as a server — and is left alone.)
 */
import { runMcpTest, type McpTestOptions } from "../../mcp-test/run.js";
import type { Modality, ModalityContext } from "../modality.js";
import { resolveConfig } from "../config.js";
import { CallBudget, RoleRouter } from "../../llm/index.js";

export const mcpTestModality: Modality = {
  name: "mcp-test",
  gated: false,
  summary: "Connect to an MCP server (stdio or Streamable HTTP) and write a model of its tools, resources and prompts",
  async run(ctx: ModalityContext): Promise<void> {
    const ac = new AbortController();
    // Ctrl-C ends the request in flight; the server process is reaped on the way out.
    const onSigint = (): void => ac.abort();
    process.once("SIGINT", onSigint);
    try {
      const flags = ctx.flags as McpTestOptions;
      // --propose-scenarios: one model call, metered; a missing provider key is refused by runMcpTest before it connects.
      let propose: McpTestOptions["propose"];
      if (flags.proposeScenarios === true) {
        try {
          const cfg = resolveConfig();
          const router = new RoleRouter(cfg, { anthropicApiKey: cfg.anthropicApiKey, openrouterApiKey: cfg.openrouterApiKey, groqApiKey: cfg.groqApiKey }, new CallBudget(1));
          propose = { invoke: router.invoke("worker", router.tierFor("worker", cfg.models.bulk)), cost: () => router.ledger.report() };
        } catch (e) {
          ctx.err(`✗ ${(e as Error).message}
`);
        }
      }
      const result = await runMcpTest({ ...flags, ...(propose ? { propose } : {}), signal: ac.signal }, { out: ctx.out, err: ctx.err });
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    } finally {
      process.off("SIGINT", onSigint);
    }
  },
};
