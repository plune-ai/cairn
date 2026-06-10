import { Box, Text } from "ink";
import type { PilotVerdict } from "../../index.js";

const COLOR: Record<PilotVerdict["verdict"], string> = {
  pass: "green",
  "needs-work": "yellow",
  fail: "red",
};

/** The holistic Pilot verdict (pass / needs-work / fail) with its reason + guidance. */
export function PilotBadge({ pilot }: { pilot: PilotVerdict }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={COLOR[pilot.verdict]}>
        Pilot: {pilot.verdict.toUpperCase()}
      </Text>
      <Text dimColor>{pilot.reason}</Text>
      {pilot.guidance ? <Text dimColor>→ {pilot.guidance}</Text> : null}
    </Box>
  );
}
