import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { useRouter } from "../router-context.js";
import { useRuns } from "../hooks/use-runs.js";

interface Item {
  label: string;
  value: string;
}

export function RunsListScreen() {
  const { navigate } = useRouter();
  const { runs, loading } = useRuns();

  if (loading) return <Text dimColor>scanning ./runs…</Text>;
  if (runs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No runs found in ./runs</Text>
        <Text dimColor>esc — back</Text>
      </Box>
    );
  }

  const items: Item[] = runs.map((r) => {
    const date = r.date.toISOString().slice(0, 16).replace("T", " ");
    const green = r.greenRatio !== undefined ? `${String(Math.round(r.greenRatio * 100))}% ` : "";
    const pilot = r.pilot ? `${r.pilot} ` : "";
    return { label: `${date}  ${r.mode}  ${green}${pilot} ${r.url}`, value: r.dir };
  });

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        Past runs ({runs.length})
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(it: Item) => navigate({ name: "runDetail", runDir: it.value })}
        />
      </Box>
    </Box>
  );
}
