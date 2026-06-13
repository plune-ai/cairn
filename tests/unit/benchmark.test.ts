import { describe, it, expect } from "vitest";
import {
  PRESETS,
  BENCH_START,
  BENCH_END,
  missingKeys,
  costPerHour,
  skippedRow,
  rowFromReport,
  renderBenchmarkTable,
  rewriteBetweenMarkers,
  type PresetSpec,
  type BenchReport,
  type BenchRow,
} from "../../scripts/benchmark-core.js";

/** Lookup helper — avoids non-null assertions in the assertions below. */
function presetByName(name: string): PresetSpec {
  const p = PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`no preset named ${name}`);
  return p;
}

/** A realistic explore report.json cost block (the only part the benchmark reads). */
function reportOk(): BenchReport {
  return {
    cost: {
      perRole: [
        { role: "worker", models: ["llama-3.3-70b-versatile"], calls: 4, inputTokens: 8000, outputTokens: 2000, totalTokens: 10000, costUsd: 0.006 },
        { role: "reasoner", models: ["claude-opus-4-8"], calls: 2, inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, costUsd: 0.05 },
        { role: "judge", models: ["claude-haiku-4-5"], calls: 1, inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costUsd: 0.002 },
      ],
      totalTokens: 17200,
      totalCostUsd: 0.058,
    },
  };
}

describe("PRESETS — default · volume · fast registry", () => {
  it("registers exactly the three routing presets in order", () => {
    expect(PRESETS.map((p) => p.name)).toEqual(["default", "volume", "fast"]);
  });

  it("default has no --routing and needs only the Anthropic key", () => {
    const def = presetByName("default");
    expect(def.routing).toBeUndefined();
    expect(def.requiredKeys).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("volume routes to OpenRouter worker (needs OpenRouter + Anthropic keys)", () => {
    const vol = presetByName("volume");
    expect(vol.routing).toBe("volume");
    expect(vol.requiredKeys).toEqual(["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]);
  });

  it("fast routes to Groq worker (needs Groq + Anthropic keys)", () => {
    const fast = presetByName("fast");
    expect(fast.routing).toBe("fast");
    expect(fast.requiredKeys).toEqual(["GROQ_API_KEY", "ANTHROPIC_API_KEY"]);
  });
});

describe("missingKeys — pure per-preset key gate", () => {
  it("returns [] when every required key is present", () => {
    const env = { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o", GROQ_API_KEY: "g" };
    expect(missingKeys(presetByName("fast"), env)).toEqual([]);
  });

  it("names exactly the absent keys (and never throws)", () => {
    const env = { ANTHROPIC_API_KEY: "a" }; // no Groq, no OpenRouter
    expect(missingKeys(presetByName("default"), env)).toEqual([]);
    expect(missingKeys(presetByName("fast"), env)).toEqual(["GROQ_API_KEY"]);
    expect(missingKeys(presetByName("volume"), env)).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("treats an empty-string key as missing", () => {
    expect(missingKeys(presetByName("default"), { ANTHROPIC_API_KEY: "" })).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

describe("costPerHour — extrapolation $/run × (3600 / seconds)", () => {
  it("computes the back-to-back hourly cost", () => {
    expect(costPerHour(0.1, 36)).toBeCloseTo(10, 6); // 0.1 × 100
  });
  it("is null-safe on unknown cost, missing or non-positive seconds", () => {
    expect(costPerHour(null, 36)).toBeNull();
    expect(costPerHour(0.1, null)).toBeNull();
    expect(costPerHour(0.1, 0)).toBeNull();
    expect(costPerHour(0.1, -5)).toBeNull();
  });
});

describe("rowFromReport — report.json cost block → benchmark row", () => {
  it("extracts tokens, $, wall-clock seconds and the per-role models", () => {
    const row = rowFromReport(presetByName("fast"), reportOk(), 30000);
    expect(row.status).toBe("ok");
    expect(row.tokens).toBe(17200);
    expect(row.costUsd).toBe(0.058);
    expect(row.seconds).toBe(30);
    expect(row.worker).toBe("llama-3.3-70b-versatile");
    expect(row.reasoner).toBe("claude-opus-4-8");
    // $/hour = 0.058 × (3600 / 30) = 6.96
    expect(row.costPerHourUsd).toBeCloseTo(6.96, 6);
  });

  it("joins multiple models used under one role with '+'", () => {
    const report: BenchReport = {
      cost: {
        perRole: [
          { role: "worker", models: ["claude-haiku-4-5", "claude-sonnet-4-6"], calls: 3, inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 },
        ],
        totalTokens: 150,
        totalCostUsd: 0.01,
      },
    };
    expect(rowFromReport(presetByName("default"), report, 1000).worker).toBe("claude-haiku-4-5+claude-sonnet-4-6");
  });

  it("falls back to the documented preset models when a role is absent from the report", () => {
    const fast = presetByName("fast");
    const report: BenchReport = { cost: { perRole: [], totalTokens: 0, totalCostUsd: 0 } };
    const row = rowFromReport(fast, report, 1000);
    expect(row.worker).toBe(fast.models.worker);
    expect(row.reasoner).toBe(fast.models.reasoner);
  });

  it("propagates an unknown ($-null) cost as null $/run and null $/hour, tokens still counted", () => {
    const report: BenchReport = {
      cost: {
        perRole: [{ role: "worker", models: ["deepseek/deepseek-chat"], calls: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null }],
        totalTokens: 15,
        totalCostUsd: null,
      },
    };
    const row = rowFromReport(presetByName("volume"), report, 10000);
    expect(row.costUsd).toBeNull();
    expect(row.costPerHourUsd).toBeNull();
    expect(row.tokens).toBe(15);
  });
});

describe("skippedRow — missing-key preset becomes an n/a row, never a throw", () => {
  it("marks the preset skipped with the reason and no metrics", () => {
    const fast = presetByName("fast");
    const env = { ANTHROPIC_API_KEY: "a" };
    let row: BenchRow | undefined;
    expect(() => {
      row = skippedRow(fast, `${missingKeys(fast, env).join(", ")} not set`);
    }).not.toThrow();
    expect(row?.status).toBe("skipped");
    expect(row?.note).toBe("GROQ_API_KEY not set");
    expect(row?.tokens).toBeNull();
    expect(row?.costUsd).toBeNull();
    expect(row?.costPerHourUsd).toBeNull();
    // models are still shown (documented defaults) even without keys
    expect(row?.worker).toBe(fast.models.worker);
    expect(row?.reasoner).toBe(fast.models.reasoner);
  });
});

describe("renderBenchmarkTable — markdown table + extrapolation caveat", () => {
  const meta = { date: "2026-06-13", commit: "abc1234", url: "https://example.com", profile: "anthropic", maxRepair: 0 };

  it("records the reproducibility config (profile + MAX_REPAIR) in the snapshot line", () => {
    const md = renderBenchmarkTable([skippedRow(presetByName("default"), "ANTHROPIC_API_KEY not set")], meta);
    expect(md).toContain("profile `anthropic`");
    expect(md).toContain("MAX_REPAIR=0");
  });

  it("renders a header, one row per preset, the n/a cell and the $/hour assumption", () => {
    const rows: BenchRow[] = [
      rowFromReport(presetByName("default"), reportOk(), 30000),
      skippedRow(presetByName("fast"), "GROQ_API_KEY not set"),
    ];
    const md = renderBenchmarkTable(rows, meta);
    expect(md).toContain("| Preset |");
    expect(md).toContain("|---|");
    expect(md).toContain("`default`");
    expect(md).toContain("`fast`");
    expect(md).toContain("17,200"); // tokens formatted
    expect(md).toContain("$0.0580"); // $/run, <1 → 4 decimals
    expect(md).toContain("$6.96"); // $/hour, >=1 → 2 decimals
    expect(md).toContain("30.0s"); // wall-clock
    expect(md).toContain("n/a — GROQ_API_KEY not set");
    expect(md).toContain("$/hour"); // assumption label present
    expect(md).toContain("extrapolation");
    expect(md).toContain("2026-06-13");
    expect(md).toContain("abc1234");
    expect(md).toContain("https://example.com");
    expect(md).toContain("ADR-0002"); // movable-prices caveat
    expect(md).toContain("npm run bench"); // reproduce line
  });

  it("shows the session in the snapshot line when one is given, else 'no session'", () => {
    const rows = [skippedRow(presetByName("default"), "ANTHROPIC_API_KEY not set")];
    expect(renderBenchmarkTable(rows, { ...meta, session: "myapp" })).toContain("session `myapp`");
    expect(renderBenchmarkTable(rows, meta)).toContain("no session");
  });

  it("clips a long, multi-line failure note to one compact, table-safe cell", () => {
    const longNote =
      'run failed: Session "valtive" looks expired — the first page looks like a login screen.\nRe-capture it: cairn session capture --url <loginUrl> --name valtive';
    const row: BenchRow = {
      preset: "default",
      status: "skipped",
      note: longNote,
      worker: "claude-sonnet-4-6",
      reasoner: "claude-opus-4-8",
      tokens: null,
      costUsd: null,
      seconds: null,
      costPerHourUsd: null,
    };
    const md = renderBenchmarkTable([row], meta);
    const rowLines = md.split("\n").filter((l) => l.startsWith("| `default`"));
    // The note must NOT split the row into multiple table lines (would corrupt the markdown table).
    expect(rowLines).toHaveLength(1);
    const line = rowLines[0] ?? "";
    expect(line).toContain("n/a — run failed: Session");
    expect(line).toContain("…"); // clipped
    expect(line).not.toContain("Re-capture it"); // tail dropped
    expect(line.length).toBeLessThan(160); // stays compact
  });

  it("renders an em-dash for every null metric on an ok row", () => {
    const blank: BenchRow = {
      preset: "blank",
      status: "ok",
      worker: "w",
      reasoner: "r",
      tokens: null,
      costUsd: null,
      seconds: null,
      costPerHourUsd: null,
    };
    expect(renderBenchmarkTable([blank], meta)).toContain("| `blank` | w | r | — | — | — | — |");
  });
});

describe("rewriteBetweenMarkers — idempotent README section rewrite", () => {
  const block = "| a | b |\n|---|---|\n| 1 | 2 |";
  const doc = `# Title\nintro\n${BENCH_START}\nOLD CONTENT\n${BENCH_END}\nfooter\n`;

  it("replaces only the content between the markers, preserving the rest", () => {
    const out = rewriteBetweenMarkers(doc, block);
    expect(out).toContain("# Title");
    expect(out).toContain("footer");
    expect(out).toContain("| 1 | 2 |");
    expect(out).not.toContain("OLD CONTENT");
    expect(out).toContain(BENCH_START);
    expect(out).toContain(BENCH_END);
    // ordering: START < block < END
    expect(out.indexOf(BENCH_START)).toBeLessThan(out.indexOf("| 1 | 2 |"));
    expect(out.indexOf("| 1 | 2 |")).toBeLessThan(out.indexOf(BENCH_END));
  });

  it("is idempotent — rewriting the same block twice is a fixed point", () => {
    const once = rewriteBetweenMarkers(doc, block);
    const twice = rewriteBetweenMarkers(once, block);
    expect(twice).toBe(once);
  });

  it("throws a clear error when the markers are missing, half-present or reversed", () => {
    expect(() => rewriteBetweenMarkers("no markers here", block)).toThrow(/marker/i);
    expect(() => rewriteBetweenMarkers(`${BENCH_START} only the start`, block)).toThrow(/marker/i);
    expect(() => rewriteBetweenMarkers(`${BENCH_END} x ${BENCH_START}`, block)).toThrow(/marker/i);
  });
});
