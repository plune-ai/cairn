import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { useRouter } from "../router-context.js";
import { ScoresTable } from "../components/scores-table.js";
import { PilotBadge } from "../components/pilot-badge.js";
import { TestCaseList } from "../components/test-case-list.js";
import type { Command, AnyResult, FormValues } from "../types.js";
import type { Score, TestCase, PilotVerdict, ValidationReport, CostReport, BudgetReport } from "../../index.js";

/** Rebuild form prefill from a finished run so re-run starts with the same target. */
function rerunInitial(command: Command, result: AnyResult): Partial<FormValues> {
  if (command === "automate") return { runDir: result.runDir };
  const url = "study" in result ? (result.study as { url?: string }).url : undefined;
  return url ? { url } : {};
}

// All numbers come from the typed result — never parsed from progress text.
function validationOf(r: AnyResult): ValidationReport | undefined {
  return "validation" in r ? r.validation : undefined;
}
function pilotOf(r: AnyResult): PilotVerdict | undefined {
  return "pilot" in r ? r.pilot : undefined;
}
function testCasesOf(r: AnyResult): TestCase[] {
  return "testCases" in r ? r.testCases : [];
}
function scoresOf(r: AnyResult): Score[] {
  return "scores" in r ? r.scores : [];
}
function specCountOf(r: AnyResult): number | undefined {
  return "specFiles" in r ? r.specFiles.length : undefined;
}
function costOf(r: AnyResult): CostReport | undefined {
  return "cost" in r ? r.cost : undefined;
}
function budgetOf(r: AnyResult): BudgetReport | undefined {
  return "budget" in r ? (r as { budget?: BudgetReport }).budget : undefined;
}
function stoppedEarlyOf(r: AnyResult): boolean {
  return "stoppedEarly" in r && Boolean((r as { stoppedEarly?: boolean }).stoppedEarly);
}

interface ActionItem {
  label: string;
  value: string;
}

export function SummaryScreen({ command, result }: { command: Command; result: AnyResult }) {
  const { navigate } = useRouter();
  const validation = validationOf(result);
  const pilot = pilotOf(result);
  const cases = testCasesOf(result);
  const scores = scoresOf(result);
  const specs = specCountOf(result);
  const cost = costOf(result);
  const budget = budgetOf(result);
  const stoppedEarly = stoppedEarlyOf(result);

  const actions: ActionItem[] = [
    { label: "View artifacts (cases · report · logs)", value: "artifacts" },
    { label: "Re-run this command", value: "rerun" },
    { label: "Back to menu", value: "menu" },
  ];

  const onAction = (item: ActionItem) => {
    if (item.value === "artifacts") navigate({ name: "runDetail", runDir: result.runDir });
    else if (item.value === "rerun")
      navigate({ name: "form", command, initial: rerunInitial(command, result) });
    else navigate({ name: "launcher" });
  };

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        {command} — done
      </Text>
      <Text dimColor>{result.runDir}</Text>

      {validation ? (
        <Box marginTop={1}>
          <Text color={validation.greenRatio >= 0.8 ? "green" : "yellow"}>
            {Math.round(validation.greenRatio * 100)}% green
          </Text>
          <Text dimColor> · flaky: {validation.flakyCount}</Text>
        </Box>
      ) : null}
      {specs !== undefined ? (
        <Box marginTop={1}>
          <Text>{specs} spec file(s) generated</Text>
        </Box>
      ) : null}

      {cost ? (
        <Box>
          <Text dimColor>
            {cost.totalTokens} tokens · {cost.totalCostUsd === null ? "$—" : `$${cost.totalCostUsd.toFixed(4)}`}
          </Text>
          {budget ? (
            <Text color={budget.max > 0 && budget.used / budget.max >= 0.8 ? "yellow" : undefined} dimColor>
              {`  · LLM calls ${budget.used}/${budget.max}`}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {stoppedEarly ? <Text color="yellow">⚠ stopped early: no progress across repair attempts</Text> : null}

      {pilot ? <PilotBadge pilot={pilot} /> : null}
      <ScoresTable scores={scores} />
      <TestCaseList cases={cases} />

      <Box marginTop={1}>
        <SelectInput items={actions} onSelect={onAction} />
      </Box>
    </Box>
  );
}
