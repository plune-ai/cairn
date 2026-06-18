/**
 * Spike S5 — Langfuse v5 (OTel) + LangGraph tracing (LIVE; requires LANGFUSE_* + an LLM key).
 * Proves: CallbackHandler nests the calls of 2 LangGraph nodes into ONE trace on self-hosted Langfuse.
 *   Run: npm run spike:s5-langfuse
 */
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { cfg, keysOf } from "./_shared.js";
import { initTelemetry } from "../src/telemetry/index.js";
import { makeModel } from "../src/llm/index.js";

const c = cfg();
if (!c.langfuse.enabled) {
  console.error("Langfuse is disabled. Fill in LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY (self-hosted) in .env.");
  process.exit(1);
}

const tel = await initTelemetry(c);
const model = makeModel(c.models.bulk, keysOf(c));

const S = Annotation.Root({
  topic: Annotation<string>,
  a: Annotation<string>,
  b: Annotation<string>,
});

const graph = new StateGraph(S)
  .addNode("nodeA", async (s) => ({
    a: String((await model.invoke([new HumanMessage(`One word about ${s.topic}`)])).content),
  }))
  .addNode("nodeB", async (s) => ({
    b: String((await model.invoke([new HumanMessage(`Another word about ${s.topic}`)])).content),
  }))
  .addEdge(START, "nodeA")
  .addEdge("nodeA", "nodeB")
  .addEdge("nodeB", END)
  .compile();

const out = await graph.invoke(
  { topic: "testing" },
  { callbacks: tel.callbackHandler ? [tel.callbackHandler] : [], runName: "spike-s5" },
);

console.log("S5 graph out:", out);
await tel.shutdown();
console.log(
  `S5 OK — open self-hosted Langfuse (${c.langfuse.baseUrl}); there should be 1 trace 'spike-s5' with nested generations nodeA/nodeB.`,
);
