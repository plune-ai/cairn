import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExperiment } from "../../src/eval/experiment.js";
import { PromptRegistry } from "../../src/prompts/index.js";
import type { StructuredInvoke } from "../../src/llm/structured.js";
import type { PageStudy } from "../../src/observe/index.js";

// Isolate from the repo's committed prompts/ overrides (#80): these variants test LOCAL prompts,
// so point overridesDir at a non-existent dir or the real prompts/qa-testcase-from-ui.md would win.
const noOverrides = join(tmpdir(), "cairn-exp-no-overrides-xyz");

const study: PageStudy = {
  url: "http://x",
  screenshotB64: "",
  ariaYaml: "",
  capturedBy: "lib",
  elements: [{ ref: "e1", role: "button", name: "Go", interactive: true, rank: 3 }],
};

// Baseline and candidate prompts differ by a marker; the fake invoke returns different cases based on it.
const baseline = new PromptRegistry({
  local: { "qa-manual-test-designer": "M", "qa-testcase-from-ui": "BASE {{elements}}" },
  overridesDir: noOverrides,
});
const candidate = new PromptRegistry({
  local: { "qa-manual-test-designer": "M", "qa-testcase-from-ui": "CANDIDATE {{elements}}" },
  overridesDir: noOverrides,
});

const designInvoke: StructuredInvoke = async (schema, messages) => {
  const isCandidate = JSON.stringify(messages).includes("CANDIDATE");
  return schema.parse({
    testCases: [
      {
        title: "T",
        technique: "exploratory",
        preconditions: [],
        steps: ["s"],
        expected: "e",
        priority: "high",
        elementRefs: isCandidate ? ["e1"] : ["eX"], // candidate grounded (e1), baseline not (eX)
      },
    ],
  });
};

describe("runExperiment (comparing prompt versions at the design stage)", () => {
  it("computes mean metrics per variant and issues a verdict (candidate better on grounding)", async () => {
    const result = await runExperiment(
      [{ id: "i1", study, pageSemantics: "Форма" }],
      [
        { label: "production", prompts: baseline },
        { label: "candidate", prompts: candidate },
      ],
      { designInvoke },
      { target: "grounding", threshold: 0.05 },
    );

    expect(result.perVariant).toHaveLength(2);
    expect(result.perVariant[0]?.meanScores.grounding).toBe(0); // baseline ungrounded
    expect(result.perVariant[1]?.meanScores.grounding).toBe(1); // candidate grounded
    expect(result.verdict?.delta).toBe(1);
    expect(result.verdict?.improved).toBe(true);
    expect(result.verdict?.candidate).toBe("candidate");
  });

  it("single variant → no verdict", async () => {
    const result = await runExperiment(
      [{ id: "i1", study, pageSemantics: "x" }],
      [{ label: "production", prompts: baseline }],
      { designInvoke },
    );
    expect(result.perVariant).toHaveLength(1);
    expect(result.verdict).toBeUndefined();
  });
});
