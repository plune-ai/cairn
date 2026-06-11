import { Box, Text } from "ink";
import type { TestCase } from "../../index.js";

/** Compact list of generated test cases (ATC=auto / MTC=manual), truncated to `limit`. */
export function TestCaseList({ cases, limit = 12 }: { cases: TestCase[]; limit?: number }) {
  if (cases.length === 0) return null;
  const shown = cases.slice(0, limit);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Test cases ({cases.length})</Text>
      {shown.map((tc) => (
        <Text key={tc.id} wrap="truncate-end">
          <Text dimColor>
            [{tc.execution === "manual" ? "MTC" : "ATC"} · {tc.priority}]
          </Text>{" "}
          {tc.title}
        </Text>
      ))}
      {cases.length > limit ? <Text dimColor>…and {cases.length - limit} more</Text> : null}
    </Box>
  );
}
