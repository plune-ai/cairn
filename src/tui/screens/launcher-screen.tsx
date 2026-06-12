import { Box, Text, useApp } from "ink";
import SelectInput from "ink-select-input";
import { useRouter } from "../router-context.js";
import type { Command } from "../types.js";

interface MenuItem {
  label: string;
  value: string;
}

const ITEMS: MenuItem[] = [
  { label: "Explore — full pipeline (cases → code → validate → repair)", value: "explore" },
  { label: "Design — test cases only (.md, no code)", value: "design" },
  { label: "Automate — generate @playwright/test from existing cases", value: "automate" },
  { label: "Browse past runs", value: "runs" },
  { label: "Quit", value: "quit" },
];

export function LauncherScreen() {
  const { navigate } = useRouter();
  const { exit } = useApp();

  const onSelect = (item: MenuItem) => {
    if (item.value === "quit") {
      exit();
      return;
    }
    if (item.value === "runs") {
      navigate({ name: "runsList" });
      return;
    }
    navigate({ name: "form", command: item.value as Command });
  };

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        Cairn
      </Text>
      <Text dimColor>Interactive UI-test generation — pick a command</Text>
      <Box marginTop={1}>
        <SelectInput items={ITEMS} onSelect={onSelect} />
      </Box>
    </Box>
  );
}
