/** A human-authored checklist item (directs WHAT to test). */
export interface ChecklistItem {
  text: string;
  priority?: "low" | "medium" | "high" | "critical";
}

/**
 * Parse a checklist into items. Supports two formats:
 * - structured doc (headings `## TC-01 …`) → take case headings as items (body is ignored);
 * - flat checklist (bullets/numbering) → take lines as items.
 */
export function ingestChecklist(raw: string): ChecklistItem[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());

  const headings = lines
    .filter((l) => /^#{2,}\s+/.test(l))
    .map((l) => l.replace(/^#{2,}\s+/, "").replace(/\*\*/g, "").trim())
    .filter((l) => l.length > 0);
  if (headings.length > 0) return headings.map((text) => ({ text }));

  return lines
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) =>
      l
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter((l) => l.length > 0)
    .map((text) => ({ text }));
}

/** Checklist text for the designer prompt ({{checklist}}). Empty → "". */
export function formatChecklist(items: ChecklistItem[]): string {
  if (items.length === 0) return "";
  return (
    "Checklist (directs the design — test EXACTLY these items and prioritize them):\n" +
    items.map((i) => `- ${i.text}`).join("\n")
  );
}

/**
 * Goal directive (#63 MEM-01): a natural-language goal that biases observation + planning toward
 * one area instead of a blind crawl. Empty/blank → "" (no bias — unchanged default behavior).
 * Used by BOTH identify-elements (prioritize goal-relevant elements) and the case designer
 * (lead with goal-relevant cases), so the wording covers elements AND scenarios.
 */
export function formatGoal(goal?: string): string {
  const g = goal?.trim();
  if (!g) return "";
  return (
    `GOAL FOR THIS RUN — bias toward this user goal: "${g}".\n` +
    "Prioritize the elements and scenarios relevant to this goal and lead with them; " +
    "de-emphasize unrelated areas (do NOT ignore a critical issue you notice elsewhere)."
  );
}

/** Detect the text language (for language-consistent design): Cyrillic → "Ukrainian", otherwise → "English". */
export function detectLanguage(text: string): string {
  return /[Ѐ-ӿ]/i.test(text) ? "Ukrainian" : "English";
}

/** Planning style (idea from explorbot): directs the design focus. "all"/unknown → "" (balanced). */
export function styleDirective(style: string): string {
  switch (style) {
    case "happy":
      return "STYLE FOR THIS RUN: focus on POSITIVE happy-path scenarios (valid data, main flows).";
    case "negative":
      return "STYLE FOR THIS RUN: focus on NEGATIVE/edge scenarios (invalid input, errors, boundaries).";
    case "coverage":
      return "STYLE FOR THIS RUN: fill coverage GAPS — scenarios that are usually missed (rare states, combinations, decision-table).";
    default:
      return "";
  }
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9а-яіїєґ]+/i)
      .filter((t) => t.length >= 4),
  );
}

/** checklist_coverage: fraction of checklist items mentioned in at least one case (by shared tokens). */
export function coverageScore(
  items: ChecklistItem[],
  cases: { title: string; steps: string[]; expected: string }[],
): number {
  if (items.length === 0) return 0;
  const caseTokens = cases.map((c) => tokens(`${c.title} ${c.steps.join(" ")} ${c.expected}`));
  const covered = items.filter((item) => {
    const itemTokens = [...tokens(item.text)];
    return caseTokens.some((ct) => itemTokens.some((t) => ct.has(t)));
  }).length;
  return covered / items.length;
}
