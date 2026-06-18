/**
 * React context exposing navigation to any screen without prop-drilling.
 * The reducer itself lives in router.ts (pure); this only wires it into React.
 */
import { createContext, useContext } from "react";
import type { Screen } from "./router.js";

export interface RouterApi {
  navigate: (screen: Screen) => void;
  back: () => void;
  replace: (screen: Screen) => void;
  canGoBack: boolean;
  /** Screens with a focused text input set this true so the global `q` shortcut doesn't steal a typed key. */
  setInTextField: (v: boolean) => void;
  /**
   * A screen may intercept the global "back" (Escape) — e.g. a wizard steps back internally.
   * Return `true` if consumed; `false`/unset → the global handler does the default router pop.
   */
  setBackHandler: (fn: (() => boolean) | null) => void;
}

const RouterContext = createContext<RouterApi | null>(null);

export const RouterProvider = RouterContext.Provider;

export function useRouter(): RouterApi {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used within a RouterProvider");
  return ctx;
}
