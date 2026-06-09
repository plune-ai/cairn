/**
 * Spike S5 — Langfuse v5 (OTel) + LangGraph трейсинг (ЖИВИЙ; потрібні LANGFUSE_* + ключ LLM).
 * Доводить: CallbackHandler вкладає виклики 2 нод LangGraph в ОДИН trace на self-hosted Langfuse.
 *   Запуск: npm run spike:s5-langfuse
 */
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { cfg, keysOf } from "./_shared.js";
import { initTelemetry } from "../src/telemetry/index.js";
import { makeModel } from "../src/llm/index.js";

const c = cfg();
if (!c.langfuse.enabled) {
  console.error("Langfuse вимкнено. Заповни LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY (self-hosted) у .env.");
  process.exit(1);
}

const tel = initTelemetry(c);
const model = makeModel(c.models.bulk, keysOf(c));

const S = Annotation.Root({
  topic: Annotation<string>,
  a: Annotation<string>,
  b: Annotation<string>,
});

const graph = new StateGraph(S)
  .addNode("nodeA", async (s) => ({
    a: String((await model.invoke([new HumanMessage(`Одне слово про ${s.topic}`)])).content),
  }))
  .addNode("nodeB", async (s) => ({
    b: String((await model.invoke([new HumanMessage(`Ще одне слово про ${s.topic}`)])).content),
  }))
  .addEdge(START, "nodeA")
  .addEdge("nodeA", "nodeB")
  .addEdge("nodeB", END)
  .compile();

const out = await graph.invoke(
  { topic: "тестування" },
  { callbacks: tel.callbackHandler ? [tel.callbackHandler] : [], runName: "spike-s5" },
);

console.log("S5 graph out:", out);
await tel.shutdown();
console.log(
  `S5 OK — відкрий self-hosted Langfuse (${c.langfuse.baseUrl}); має бути 1 trace 'spike-s5' із вкладеними generations nodeA/nodeB.`,
);
