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
  /** Screens with a focused text input set this true so global `q`/esc don't steal keys. */
  setInTextField: (v: boolean) => void;
}

const RouterContext = createContext<RouterApi | null>(null);

export const RouterProvider = RouterContext.Provider;

export function useRouter(): RouterApi {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used within a RouterProvider");
  return ctx;
}
