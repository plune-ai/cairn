import { Box, Text } from "ink";

/** Tail of the raw progress log (last `height` lines). */
export function LogPane({ log, height = 6 }: { log: string[]; height?: number }) {
  const tail = log.slice(-height);
  if (tail.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {tail.map((line, i) => (
        <Text key={`${String(i)}:${line}`} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
