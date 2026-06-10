import { useEffect, useState } from "react";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface SessionsState {
  names: string[];
  loading: boolean;
}

/**
 * Lists saved session names from `.auth/*.storageState.json` (SessionStore convention).
 * Best-effort: a missing `.auth/` directory yields an empty list, never throws.
 */
export function useSessions(dir = ".auth"): SessionsState {
  const [state, setState] = useState<SessionsState>({ names: [], loading: true });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const files = await readdir(resolve(dir));
        const names = files
          .filter((f) => f.endsWith(".storageState.json"))
          .map((f) => f.replace(/\.storageState\.json$/, ""));
        if (!cancelled) setState({ names, loading: false });
      } catch {
        if (!cancelled) setState({ names: [], loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dir]);

  return state;
}
