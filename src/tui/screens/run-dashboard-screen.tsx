import { useEffect } from "react";
import { Box, Text } from "ink";
import { useRouter } from "../router-context.js";
import { useRunner } from "../hooks/use-runner.js";
import { NodeChecklist } from "../components/node-checklist.js";
import { LogPane } from "../components/log-pane.js";
import type { Command, FormValues } from "../types.js";

const ERROR_HINTS: Record<string, string> = {
  session: "Session looks expired/missing — recapture it (npm run session:save).",
  "rate-limit": "Rate-limited (429). The SDK retried; try again shortly.",
  budget: "Call budget exceeded — the run hit the cost guardrail.",
  config: "Check your API key env (ANTHROPIC_API_KEY / OPENROUTER_API_KEY).",
  unknown: "Unexpected error — see the message above.",
};

/** Runs the command and shows a live node checklist + log; routes to summary on success. */
export function RunDashboardScreen({ command, values }: { command: Command; values: FormValues }) {
  const { replace, setInTextField } = useRouter();
  const { state, start, dispose } = useRunner();

  useEffect(() => {
    setInTextField(false);
    start(command, values);
    return dispose;
    // run once on mount
  }, []);

  useEffect(() => {
    if (state.phase === "done" && state.result) {
      replace({ name: "summary", command, result: state.result });
    }
  }, [state.phase]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          {command}
        </Text>
        <Text dimColor>{state.phase === "running" ? "  running…" : `  ${state.phase}`}</Text>
        {state.liveGreen !== undefined && <Text color="green">{`  · ${String(state.liveGreen)}% green`}</Text>}
      </Box>

      <Box marginTop={1}>
        <NodeChecklist nodes={state.nodes} />
      </Box>

      <LogPane log={state.log} />

      {state.phase === "error" && state.error && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>
            Failed: {state.error.kind}
          </Text>
          <Text>{state.error.message}</Text>
          <Text dimColor>{ERROR_HINTS[state.error.kind] ?? ""}</Text>
          <Text dimColor>esc — back to the form</Text>
        </Box>
      )}
    </Box>
  );
}
