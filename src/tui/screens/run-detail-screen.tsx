import { useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { useRunArtifacts } from "../hooks/use-run-artifacts.js";
import { useStdoutDimensions } from "../hooks/use-stdout-dimensions.js";
import { ScrollableText } from "../components/scrollable-text.js";
import { promoteCase } from "../../promote/index.js";

const TABS = ["cases", "report", "logs"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { cases: "Cases", report: "Report", logs: "Logs" };

/** Tabbed artifact viewer. Tabs: 1/2/3 or ←→ · scroll: ↑↓ · cases: n/p · back: esc. */
export function RunDetailScreen({ runDir }: { runDir: string }) {
  const arts = useRunArtifacts(runDir);
  const [, rows] = useStdoutDimensions();
  const [tab, setTab] = useState<Tab>("cases");
  const [caseIdx, setCaseIdx] = useState(0);
  const [note, setNote] = useState<string>("");
  const [promoted, setPromoted] = useState(false);

  // Derive current case here (before useInput) so the key handler can reference it.
  const current = arts.cases[caseIdx];

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
    } else if (tab === "cases" && input === "a" && !promoted && current?.name.startsWith("MTC")) {
      const id = current.name.replace(/\.md$/, "");
      void promoteCase(runDir, id, {})
        .then((r) => {
          setPromoted(true);
          setNote(`Promoted ${r.oldId} → ${r.newId}${r.warning ? ` (⚠ ${r.warning})` : ""}`);
          arts.reload();
        })
        .catch((e: unknown) => setNote(`Promote failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });

  if (arts.loading) return <Text dimColor>loading artifacts…</Text>;
  const viewHeight = Math.max(6, rows - 10);

  let body: ReactNode;
  if (tab === "cases") {
    body = current ? (
      <ScrollableText key={caseIdx} text={current.text} height={viewHeight} />
    ) : (
      <Text dimColor>No test cases in this run.</Text>
    );
  } else if (tab === "report") {
    body = <ScrollableText text={arts.report} height={viewHeight} />;
  } else {
    body = <ScrollableText text={arts.log} height={viewHeight} />;
  }

  const isMtc = tab === "cases" && (current?.name.startsWith("MTC") ?? false);
  const hint =
    tab === "cases" && arts.cases.length > 1
      ? `↑↓ scroll · n/p next·prev case${isMtc ? " · a promote→ATC" : ""} · 1/2/3 or ←→ tab · esc back`
      : `↑↓ scroll${isMtc ? " · a promote→ATC" : ""} · 1/2/3 or ←→ tab · esc back`;

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
          <Text>
            <Text color="cyan">
              case {caseIdx + 1}/{arts.cases.length}
            </Text>
            <Text dimColor> · {current.name}</Text>
            {arts.cases.length > 1 ? (
              <Text color="yellow">  ·  press n/p for next/prev</Text>
            ) : null}
          </Text>
        ) : null}
        {body}
      </Box>

      {note ? <Text color="green">{note}</Text> : null}
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
