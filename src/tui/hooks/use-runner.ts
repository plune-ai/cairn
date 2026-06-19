import { useReducer, useRef } from "react";
import { readFile } from "node:fs/promises";
import { resolveConfig, runExploration, runDesign, runAutomate } from "../../index.js";
import type { Command, FormValues, AnyResult, NodeStatus } from "../types.js";
import { nodesFor, seedNodes, parseNode, advanceNodes, completeNodes } from "../theme.js";

export type RunPhase = "idle" | "running" | "done" | "error";
export type ErrorKind = "session" | "rate-limit" | "budget" | "config" | "unknown";

export interface RunnerState {
  phase: RunPhase;
  nodes: NodeStatus[];
  log: string[];
  liveGreen?: number;
  result?: AnyResult;
  error?: { message: string; kind: ErrorKind };
}

type Action =
  | { type: "start"; nodes: NodeStatus[] }
  | { type: "progress"; event: string }
  | { type: "done"; result: AnyResult }
  | { type: "error"; message: string; kind: ErrorKind };

const MAX_LOG = 200;
const initial: RunnerState = { phase: "idle", nodes: [], log: [] };

function reducer(state: RunnerState, action: Action): RunnerState {
  switch (action.type) {
    case "start":
      return { phase: "running", nodes: action.nodes, log: [] };
    case "progress": {
      const { node } = parseNode(action.event);
      const nodes = node ? advanceNodes(state.nodes, node) : state.nodes;
      const log = [...state.log, action.event].slice(-MAX_LOG);
      let liveGreen = state.liveGreen;
      if (node === "validate") {
        const m = action.event.match(/(\d+)\s*%/);
        if (m?.[1]) liveGreen = Number(m[1]);
      }
      return { ...state, nodes, log, liveGreen };
    }
    case "done":
      return { ...state, phase: "done", nodes: completeNodes(state.nodes), result: action.result };
    case "error":
      return { ...state, phase: "error", error: { message: action.message, kind: action.kind } };
  }
}

/** Classify a thrown error by message substring → a friendly recovery hint on screen. */
function classify(message: string): ErrorKind {
  const m = message.toLowerCase();
  if (m.includes("storagestate") || m.includes("session") || m.includes("expired") || m.includes("login"))
    return "session";
  if (m.includes("429") || m.includes("rate limit") || m.includes("overloaded")) return "rate-limit";
  if (m.includes("budget") || m.includes("call cap") || m.includes("callbudget")) return "budget";
  if (m.includes("api key") || m.includes("api_key") || m.includes("apikey") || m.includes("anthropic") || m.includes("openrouter"))
    return "config";
  return "unknown";
}

/**
 * Drives a single command run. `start` is fire-and-forget (never awaited in render);
 * progress events flow through the reducer so Ink coalesces frames. `dispose` (on unmount)
 * stops further state updates while the underlying SDK run finishes on its own.
 */
export function useRunner() {
  const [state, dispatch] = useReducer(reducer, initial);
  const cancelled = useRef(false);
  const started = useRef(false);

  const start = (command: Command, values: FormValues): void => {
    if (started.current) return;
    started.current = true;
    dispatch({ type: "start", nodes: seedNodes(nodesFor(command)) });

    void (async () => {
      try {
        // Parity with the CLI: form-chosen backend/channel/routing override env (resolveConfig only
        // touches a SET flag), so a TUI run can match `cairn … --channel chrome` etc.
        const config = resolveConfig(
          { backend: values.backend, channel: values.channel, routing: values.routing },
          process.env,
        );
        const onProgress = (event: string): void => {
          if (!cancelled.current) dispatch({ type: "progress", event });
        };
        const checklistText = values.checklist
          ? await readFile(values.checklist, "utf8")
          : undefined;

        let result: AnyResult;
        if (command === "automate") {
          result = await runAutomate({
            runDir: values.runDir ?? "",
            config,
            sessionName: values.session,
            sessionFile: values.sessionFile,
            validate: values.validate,
            onProgress,
          });
        } else if (command === "design") {
          result = await runDesign({
            url: values.url,
            config,
            sessionName: values.session,
            sessionFile: values.sessionFile,
            checklistText,
            style: values.style,
            headed: values.headed,
            fresh: values.fresh,
            onProgress,
          });
        } else {
          result = await runExploration({
            url: values.url,
            config,
            sessionName: values.session,
            sessionFile: values.sessionFile,
            checklistText,
            style: values.style,
            headed: values.headed,
            fresh: values.fresh,
            onProgress,
          });
        }
        if (!cancelled.current) dispatch({ type: "done", result });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!cancelled.current) dispatch({ type: "error", message, kind: classify(message) });
      }
    })();
  };

  const dispose = (): void => {
    cancelled.current = true;
  };

  return { state, start, dispose };
}
