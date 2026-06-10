import { useState } from "react";
import { Box, Text, useInput } from "ink";

/** A vertically scrollable text viewport (↑↓ / j k / pgup pgdn). Owns only up/down keys. */
export function ScrollableText({ text, height }: { text: string; height: number }) {
  const lines = text.split("\n");
  const [offset, setOffset] = useState(0);
  const maxOffset = Math.max(0, lines.length - height);

  useInput((input, key) => {
    if (key.downArrow || input === "j") setOffset((o) => Math.min(o + 1, maxOffset));
    else if (key.upArrow || input === "k") setOffset((o) => Math.max(o - 1, 0));
    else if (key.pageDown) setOffset((o) => Math.min(o + height, maxOffset));
    else if (key.pageUp) setOffset((o) => Math.max(o - height, 0));
  });

  const shown = lines.slice(offset, offset + height);
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => (
        <Text key={String(offset + i)} wrap="truncate-end">
          {l.length > 0 ? l : " "}
        </Text>
      ))}
      {maxOffset > 0 ? (
        <Text dimColor>
          ── {offset + 1}-{Math.min(offset + height, lines.length)}/{lines.length} (↑↓ scroll) ──
        </Text>
      ) : null}
    </Box>
  );
}
