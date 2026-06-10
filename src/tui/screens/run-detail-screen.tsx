import { useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { useRunArtifacts } from "../hooks/use-run-artifacts.js";
import { useStdoutDimensions } from "../hooks/use-stdout-dimensions.js";
import { ScrollableText } from "../components/scrollable-text.js";

const TABS = ["cases", "report", "logs"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { cases: "Cases", report: "Report", logs: "Logs" };

/** Tabbed artifact viewer. Tabs: 1/2/3 or ←→ · scroll: ↑↓ · cases: n/p · back: esc. */
export function RunDetailScreen({ runDir }: { runDir: string }) {
  const arts = useRunArtifacts(runDir);
  const [, rows] = useStdoutDimensions();
  const [tab, setTab] = useState<Tab>("cases");
  const [caseIdx, setCaseIdx] = useState(0);

  useInput((input, key) => {
    if (input === "1") setTab("cases");
    else if (input === "2") setTab("report");
    else if (input === "3") setTab("logs");
    else if (key.leftArrow) setTab((t) => TABS[(TABS.indexOf(t) + TABS.length - 1) % TABS.length] ?? "cases");
    else if (key.rightArrow || key.tab) setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length] ?? "cases");
    else if (tab === "cases" && input === "n") {
      setCaseIdx((i) => Math.min(i + 1, Math.max(0, arts.cases.length - 1)));
    } else if (tab === "cases" && input === "p") {
      setCaseIdx((i) => Math.max(i - 1, 0));
    }
  });

  if (arts.loading) return <Text dimColor>loading artifacts…</Text>;
  const viewHeight = Math.max(6, rows - 10);

  const current = arts.cases[caseIdx];
  let body: ReactNode;
  if (tab === "cases") {
    body = current ? (
      <ScrollableText text={current.text} height={viewHeight} />
    ) : (
      <Text dimColor>No test cases in this run.</Text>
    );
  } else if (tab === "report") {
    body = <ScrollableText text={arts.report} height={viewHeight} />;
  } else {
    body = <ScrollableText text={arts.log} height={viewHeight} />;
  }

  const hint =
    tab === "cases" && arts.cases.length > 1
      ? `1/2/3 or ←→ switch tab · ↑↓ scroll · n/p case · esc back`
      : `1/2/3 or ←→ switch tab · ↑↓ scroll · esc back`;

  return (
    <Box flexDirection="column">
      {/* Explicit, numbered tab bar — active tab is inverted so "where am I" is obvious. */}
      <Box>
        {TABS.map((t, i) => (
          <Box key={t} marginRight={1}>
            <Text
              color={t === tab ? "black" : "cyan"}
              backgroundColor={t === tab ? "cyan" : undefined}
              bold={t === tab}
            >
              {` ${String(i + 1)} ${TAB_LABELS[t]} `}
            </Text>
          </Box>
        ))}
      </Box>

      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} marginTop={1}>
        {tab === "cases" && current ? (
          <Text dimColor>
            case {caseIdx + 1}/{arts.cases.length} · {current.name}
          </Text>
        ) : null}
        {body}
      </Box>

      <Text dimColor>{hint}</Text>
    </Box>
  );
}
