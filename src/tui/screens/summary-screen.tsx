import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { useRouter } from "../router-context.js";
import { ScoresTable } from "../components/scores-table.js";
import { PilotBadge } from "../components/pilot-badge.js";
import { TestCaseList } from "../components/test-case-list.js";
import type { Command, AnyResult, FormValues } from "../types.js";
import type { Score, TestCase, PilotVerdict, ValidationReport } from "../../index.js";

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

      {pilot ? <PilotBadge pilot={pilot} /> : null}
      <ScoresTable scores={scores} />
      <TestCaseList cases={cases} />

      <Box marginTop={1}>
        <SelectInput items={actions} onSelect={onAction} />
      </Box>
    </Box>
  );
}
