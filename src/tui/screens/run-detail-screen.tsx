import { useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { useRunArtifacts } from "../hooks/use-run-artifacts.js";
import { useStdoutDimensions } from "../hooks/use-stdout-dimensions.js";
import { ScrollableText } from "../components/scrollable-text.js";

type Tab = "cases" | "report" | "logs";
const TABS: Tab[] = ["cases", "report", "logs"];

/** Tabbed artifact viewer: ←→ switch tabs, ↑↓ scroll, n/p cycle test cases. */
export function RunDetailScreen({ runDir }: { runDir: string }) {
  const arts = useRunArtifacts(runDir);
  const [, rows] = useStdoutDimensions();
  const [tab, setTab] = useState<Tab>("cases");
  const [caseIdx, setCaseIdx] = useState(0);

  useInput((input, key) => {
    if (key.leftArrow || input === "h") {
      setTab((t) => TABS[(TABS.indexOf(t) + TABS.length - 1) % TABS.length] ?? "cases");
    } else if (key.rightArrow || key.tab || input === "l") {
      setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length] ?? "cases");
    } else if (tab === "cases" && input === "n") {
      setCaseIdx((i) => Math.min(i + 1, Math.max(0, arts.cases.length - 1)));
    } else if (tab === "cases" && input === "p") {
      setCaseIdx((i) => Math.max(i - 1, 0));
    }
  });

  if (arts.loading) return <Text dimColor>loading artifacts…</Text>;
  const viewHeight = Math.max(6, rows - 8);

  let body: ReactNode;
  if (tab === "cases") {
    const c = arts.cases[caseIdx];
    body = c ? (
      <Box flexDirection="column">
        <Text dimColor>
          {c.name} ({caseIdx + 1}/{arts.cases.length}) · n/p switch case
        </Text>
        <ScrollableText text={c.text} height={viewHeight} />
      </Box>
    ) : (
      <Text>No test cases in this run.</Text>
    );
  } else if (tab === "report") {
    body = <ScrollableText text={arts.report} height={viewHeight} />;
  } else {
    body = <ScrollableText text={arts.log} height={viewHeight} />;
  }

  return (
    <Box flexDirection="column">
      <Box>
        {TABS.map((t) => (
          <Box key={t} marginRight={2}>
            <Text bold={t === tab} color={t === tab ? "cyan" : undefined} dimColor={t !== tab}>
              {t}
            </Text>
          </Box>
        ))}
        <Text dimColor>(←→ tabs · ↑↓ scroll · esc back)</Text>
      </Box>
      <Box marginTop={1}>{body}</Box>
    </Box>
  );
}
