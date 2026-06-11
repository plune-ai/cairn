/**
 * Pure screen router for the TUI: a stack of screens with go/back/replace.
 * Kept free of React so it is trivially unit-testable (router.test.ts).
 */
import type { Command, FormValues, AnyResult } from "./types.js";

export type Screen =
  | { name: "launcher" }
  | { name: "form"; command: Command; initial?: Partial<FormValues> }
  | { name: "dashboard"; command: Command; values: FormValues }
  | { name: "summary"; command: Command; result: AnyResult }
  | { name: "runsList" }
  | { name: "runDetail"; runDir: string };

export interface RouterState {
  stack: Screen[];
}

export type RouterAction =
  | { type: "go"; screen: Screen }
  | { type: "back" }
  | { type: "replace"; screen: Screen };

export const initialRouter: RouterState = { stack: [{ name: "launcher" }] };

export function routerReducer(state: RouterState, action: RouterAction): RouterState {
  switch (action.type) {
    case "go":
      return { stack: [...state.stack, action.screen] };
    case "back":
      // Never pop the root screen.
      return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
    case "replace":
      return { stack: [...state.stack.slice(0, -1), action.screen] };
  }
}

/** The visible (top-of-stack) screen. The stack is never empty (seeded with launcher). */
export function currentScreen(state: RouterState): Screen {
  const top = state.stack[state.stack.length - 1];
  return top ?? { name: "launcher" };
}

/** Whether back navigation is possible (i.e. not at the root). */
export function canGoBack(state: RouterState): boolean {
  return state.stack.length > 1;
}
