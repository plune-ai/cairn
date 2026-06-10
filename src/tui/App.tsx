import { useReducer, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { routerReducer, initialRouter, currentScreen, canGoBack, type Screen } from "./router.js";
import { RouterProvider, type RouterApi } from "./router-context.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { Help } from "./components/help.js";
import { LauncherScreen } from "./screens/launcher-screen.js";
import { FormScreen } from "./screens/form-screen.js";
import { RunDashboardScreen } from "./screens/run-dashboard-screen.js";
import { SummaryScreen } from "./screens/summary-screen.js";
import { RunsListScreen } from "./screens/runs-list-screen.js";
import { RunDetailScreen } from "./screens/run-detail-screen.js";

/**
 * Root component: holds router state, exposes navigation via context, and owns the
 * global keys (q quit, esc back) — suppressed while a text field is focused.
 */
export function App() {
  const { exit } = useApp();
  const [router, dispatch] = useReducer(routerReducer, initialRouter);
  const [inTextField, setInTextField] = useState(false);
  const screen = currentScreen(router);
  const backable = canGoBack(router);

  const api: RouterApi = {
    navigate: (s) => dispatch({ type: "go", screen: s }),
    back: () => dispatch({ type: "back" }),
    replace: (s) => dispatch({ type: "replace", screen: s }),
    canGoBack: backable,
    setInTextField,
  };

  useInput((input, key) => {
    if (inTextField) return; // text fields own their keystrokes
    if (input === "q") {
      exit();
      return;
    }
    if (key.escape && backable) dispatch({ type: "back" });
  });

  return (
    <RouterProvider value={api}>
      <ErrorBoundary>
        <Box flexDirection="column" padding={1}>
          {renderScreen(screen)}
          {/* The artifact viewer has its own context hint; the generic one would contradict it. */}
          {screen.name !== "runDetail" ? <Help canGoBack={backable} /> : null}
        </Box>
      </ErrorBoundary>
    </RouterProvider>
  );
}

function renderScreen(screen: Screen) {
  switch (screen.name) {
    case "launcher":
      return <LauncherScreen />;
    case "form":
      return <FormScreen command={screen.command} initial={screen.initial} />;
    case "dashboard":
      return <RunDashboardScreen command={screen.command} values={screen.values} />;
    case "summary":
      return <SummaryScreen command={screen.command} result={screen.result} />;
    case "runsList":
      return <RunsListScreen />;
    case "runDetail":
      return <RunDetailScreen runDir={screen.runDir} />;
    default:
      return null;
  }
}
