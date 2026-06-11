import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { NodeStatus } from "../types.js";
import { NODE_LABELS } from "../theme.js";

/** Live checklist of graph nodes: ✓ done · spinner running · · pending. */
export function NodeChecklist({ nodes }: { nodes: NodeStatus[] }) {
  return (
    <Box flexDirection="column">
      {nodes.map((n) => (
        <Box key={n.node}>
          <Box width={3}>
            {n.state === "done" ? (
              <Text color="green">✓</Text>
            ) : n.state === "running" ? (
              <Text color="cyan">
                <Spinner type="dots" />
              </Text>
            ) : (
              <Text dimColor>·</Text>
            )}
          </Box>
          <Text
            color={n.state === "running" ? "cyan" : n.state === "done" ? "green" : undefined}
            dimColor={n.state === "pending"}
          >
            {NODE_LABELS[n.node] ?? n.node}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
