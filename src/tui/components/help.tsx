import { Box, Text } from "ink";

/** One-line key hints at the bottom of every screen. */
export function Help({ canGoBack }: { canGoBack: boolean }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        ↑↓ move · ⏎ select{canGoBack ? " · esc back" : ""} · q quit
      </Text>
    </Box>
  );
}
