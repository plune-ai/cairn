/**
 * TUI entry point. Lazily imported by the CLI dispatch when `cairn` runs with
 * no arguments in a TTY — this keeps React/Ink out of every non-TUI code path
 * (other CLI commands and library embedders never load them).
 */
export async function mountTui(): Promise<void> {
  let React: typeof import("react");
  let render: typeof import("ink")["render"];
  let App: typeof import("./App.js")["App"];
  try {
    React = (await import("react")).default;
    ({ render } = await import("ink"));
    ({ App } = await import("./App.js"));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      process.stderr.write(
        "[cairn] The interactive TUI needs optional deps that are not installed.\n" +
          "  Install:  npm i ink react ink-select-input ink-spinner ink-text-input\n" +
          "  Or use explicit commands (no TUI needed):  cairn explore <url> · cairn design <url>\n",
      );
      return;
    }
    throw e;
  }
  const { waitUntilExit } = render(React.createElement(App), { exitOnCtrlC: true });
  await waitUntilExit();
}
