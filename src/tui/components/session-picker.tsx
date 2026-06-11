import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { useSessions } from "../hooks/use-sessions.js";

interface Item {
  label: string;
  value: string;
}

/** Picks a saved session (or none) from `.auth/`. Empty value → undefined. */
export function SessionPicker({ onSelect }: { onSelect: (session: string | undefined) => void }) {
  const { names, loading } = useSessions();
  if (loading) return <Text dimColor>loading sessions…</Text>;

  const items: Item[] = [
    { label: "(no session)", value: "" },
    ...names.map((n) => ({ label: n, value: n })),
  ];

  return (
    <Box flexDirection="column">
      <Text>Session:</Text>
      <SelectInput items={items} onSelect={(it: Item) => onSelect(it.value || undefined)} />
    </Box>
  );
}
