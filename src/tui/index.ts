/**
 * TUI entry point. Lazily imported by the CLI dispatch when `cairn` runs with
 * no arguments in a TTY — this keeps React/Ink out of every non-TUI code path
 * (other CLI commands and library embedders never load them).
 */
export async function mountTui(): Promise<void> {
  const React = (await import("react")).default;
  const { render } = await import("ink");
  const { App } = await import("./App.js");
  const { waitUntilExit } = render(React.createElement(App), { exitOnCtrlC: true });
  await waitUntilExit();
}
