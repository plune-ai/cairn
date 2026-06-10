import { Box, Text } from "ink";
import type { Score } from "../../index.js";

/** Hand-rolled scores table (avoids ink-table's ESM friction). Color by value band. */
export function ScoresTable({ scores }: { scores: Score[] }) {
  if (scores.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Metrics</Text>
      {scores.map((s) => (
        <Box key={s.name}>
          <Box width={26}>
            <Text dimColor>{s.name}</Text>
          </Box>
          <Text color={s.value >= 0.8 ? "green" : s.value >= 0.5 ? "yellow" : "red"}>
            {s.value.toFixed(2)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
