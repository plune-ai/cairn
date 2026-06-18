import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useRouter } from "../router-context.js";
import { stepBack } from "../keys.js";
import { Field } from "../components/field.js";
import { SessionPicker } from "../components/session-picker.js";
import type { Command, FormValues, PlanningStyle } from "../types.js";

type StepKey =
  | "url"
  | "runDir"
  | "session"
  | "checklist"
  | "style"
  | "headed"
  | "validate"
  | "backend"
  | "channel"
  | "routing"
  | "submit";

function stepsFor(command: Command): StepKey[] {
  // backend/channel/routing give the TUI parity with the CLI flags (--backend/--channel/--routing);
  // observe runs no LLM, so it omits routing. "(default)" on any of them leaves the env untouched.
  if (command === "automate") return ["runDir", "session", "validate", "backend", "channel", "routing", "submit"];
  if (command === "observe") return ["url", "session", "headed", "backend", "channel", "submit"];
  return ["url", "session", "checklist", "style", "headed", "backend", "channel", "routing", "submit"]; // explore / design
}

const STYLE_ITEMS = [
  { label: "all — full coverage", value: "all" },
  { label: "happy — positive paths", value: "happy" },
  { label: "negative — error cases", value: "negative" },
  { label: "coverage — breadth", value: "coverage" },
];
const YESNO = [
  { label: "no", value: "no" },
  { label: "yes", value: "yes" },
];
// "(default)" → empty value → leave env/default untouched (resolveConfig only overrides a SET flag).
const BACKEND_ITEMS = [
  { label: "(default — lib / env)", value: "" },
  { label: "lib — Playwright library", value: "lib" },
  { label: "cli — @playwright/cli wrapper", value: "cli" },
];
const CHANNEL_ITEMS = [
  { label: "(default — bundled Chromium)", value: "" },
  { label: "chrome — system Chrome", value: "chrome" },
  { label: "msedge — system Edge", value: "msedge" },
];
const ROUTING_ITEMS = [
  { label: "(default — profile/env)", value: "" },
  { label: "fast — Groq worker", value: "fast" },
  { label: "volume — OpenRouter worker", value: "volume" },
];

/** Sequential wizard: one field per step, ⏎ advances, last step runs the command. */
export function FormScreen({ command, initial }: { command: Command; initial?: Partial<FormValues> }) {
  const { navigate, setInTextField, setBackHandler } = useRouter();
  const [values, setValues] = useState<FormValues>({ url: "", style: "all", headed: false, ...initial });
  const [stepIndex, setStepIndex] = useState(0);

  const steps = stepsFor(command);
  const step: StepKey = steps[stepIndex] ?? "submit";
  const isText = step === "url" || step === "runDir" || step === "checklist";

  // Suppress the global `q` shortcut only while a text field owns the keyboard (Escape is unaffected).
  useEffect(() => {
    setInTextField(isText);
    return () => setInTextField(false);
  }, [isText, setInTextField]);

  // Escape steps back through the wizard; at step 0 it isn't consumed, so App pops to the launcher.
  useEffect(() => {
    setBackHandler(() => {
      const r = stepBack(stepIndex);
      if (r.consumed) setStepIndex(r.stepIndex);
      return r.consumed;
    });
    return () => setBackHandler(null);
  }, [stepIndex, setBackHandler]);

  const advance = () => setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  const set = <K extends keyof FormValues>(k: K, v: FormValues[K]) =>
    setValues((s) => ({ ...s, [k]: v }));

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        {command}
      </Text>
      <FormSummary values={values} command={command} />
      <Box marginTop={1}>{renderStep()}</Box>
    </Box>
  );

  function renderStep() {
    switch (step) {
      case "url":
        return (
          <Field
            label="URL"
            value={values.url}
            onChange={(v) => set("url", v)}
            onSubmit={() => values.url.trim() && advance()}
            placeholder="https://app.example.com/page  (required)"
          />
        );
      case "runDir":
        return (
          <Field
            label="Run dir"
            value={values.runDir ?? ""}
            onChange={(v) => set("runDir", v)}
            onSubmit={() => (values.runDir ?? "").trim() && advance()}
            placeholder="runs/<id>  (required)"
          />
        );
      case "checklist":
        return (
          <Field
            label="Checklist"
            value={values.checklist ?? ""}
            onChange={(v) => set("checklist", v)}
            onSubmit={advance}
            placeholder="(optional) path to a .md file"
          />
        );
      case "session":
        return (
          <SessionPicker
            onSelect={(s) => {
              set("session", s);
              advance();
            }}
          />
        );
      case "style":
        return (
          <Box flexDirection="column">
            <Text>Planning style:</Text>
            <SelectInput
              items={STYLE_ITEMS}
              onSelect={(it) => {
                set("style", it.value as PlanningStyle);
                advance();
              }}
            />
          </Box>
        );
      case "headed":
        return (
          <Box flexDirection="column">
            <Text>Headed (visible) browser?</Text>
            <SelectInput
              items={YESNO}
              onSelect={(it) => {
                set("headed", it.value === "yes");
                advance();
              }}
            />
          </Box>
        );
      case "validate":
        return (
          <Box flexDirection="column">
            <Text>Validate (run the generated tests)?</Text>
            <SelectInput
              items={YESNO}
              onSelect={(it) => {
                set("validate", it.value === "yes");
                advance();
              }}
            />
          </Box>
        );
      case "backend":
        return (
          <Box flexDirection="column">
            <Text>Browser backend:</Text>
            <SelectInput
              items={BACKEND_ITEMS}
              onSelect={(it) => {
                set("backend", (it.value || undefined) as FormValues["backend"]);
                advance();
              }}
            />
          </Box>
        );
      case "channel":
        return (
          <Box flexDirection="column">
            <Text>Browser channel (drive a system browser):</Text>
            <SelectInput
              items={CHANNEL_ITEMS}
              onSelect={(it) => {
                set("channel", it.value || undefined);
                advance();
              }}
            />
          </Box>
        );
      case "routing":
        return (
          <Box flexDirection="column">
            <Text>LLM routing preset:</Text>
            <SelectInput
              items={ROUTING_ITEMS}
              onSelect={(it) => {
                set("routing", it.value || undefined);
                advance();
              }}
            />
          </Box>
        );
      case "submit":
        return (
          <SubmitStep
            command={command}
            onRun={() => navigate({ name: "dashboard", command, values })}
          />
        );
    }
  }
}

function SubmitStep({ command, onRun }: { command: Command; onRun: () => void }) {
  useInput((_, key) => {
    if (key.return) onRun();
  });
  return (
    <Box flexDirection="column">
      <Text color="green">Ready to run {command}.</Text>
      <Text dimColor>Press ⏎ to start · esc to go back</Text>
    </Box>
  );
}

function FormSummary({ values, command }: { values: FormValues; command: Command }) {
  const rows: string[] = [];
  if (command === "automate") {
    if (values.runDir) rows.push(`run dir: ${values.runDir}`);
    if (values.validate !== undefined) rows.push(`validate: ${values.validate ? "yes" : "no"}`);
  } else {
    if (values.url) rows.push(`url: ${values.url}`);
    if (command !== "observe") {
      if (values.checklist) rows.push(`checklist: ${values.checklist}`);
      rows.push(`style: ${values.style}`);
    }
  }
  if (values.session) rows.push(`session: ${values.session}`);
  if (values.backend) rows.push(`backend: ${values.backend}`);
  if (values.channel) rows.push(`channel: ${values.channel}`);
  if (values.routing) rows.push(`routing: ${values.routing}`);
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((r) => (
        <Text key={r} dimColor>
          · {r}
        </Text>
      ))}
    </Box>
  );
}
