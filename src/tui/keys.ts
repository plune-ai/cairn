/**
 * Pure key-handling logic for the TUI, kept free of React/Ink so it is trivially unit-testable
 * (same philosophy as router.ts). App.tsx maps these intents onto exit()/router navigation.
 */

export type KeyAction = { type: "quit" } | { type: "back" } | null;

/**
 * Maps a keypress to a global intent.
 * - Escape ALWAYS backs out — even while a text field owns the keyboard (esc is not a printable key,
 *   so the field does not need it). This is what lets the user leave a form from its first (text) step.
 * - "q" quits only when no text field is focused (otherwise it is a character being typed).
 */
export function globalKeyAction(
  input: string,
  key: { escape?: boolean },
  opts: { inTextField: boolean },
): KeyAction {
  if (key.escape) return { type: "back" };
  if (opts.inTextField) return null; // the focused text field owns printable keys (incl. "q")
  if (input === "q") return { type: "quit" };
  return null;
}

/**
 * Wizard step-back. Returns the previous step and `consumed: true` when there is somewhere to go back
 * to; at step 0 returns `consumed: false` so the caller pops the whole screen (form → launcher) instead.
 */
export function stepBack(stepIndex: number): { stepIndex: number; consumed: boolean } {
  return stepIndex > 0 ? { stepIndex: stepIndex - 1, consumed: true } : { stepIndex, consumed: false };
}
