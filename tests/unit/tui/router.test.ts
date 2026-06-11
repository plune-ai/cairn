import { describe, it, expect } from "vitest";
import {
  routerReducer,
  initialRouter,
  currentScreen,
  canGoBack,
  type RouterState,
} from "../../../src/tui/router.js";

describe("router reducer", () => {
  it("starts at the launcher with no back", () => {
    expect(currentScreen(initialRouter).name).toBe("launcher");
    expect(canGoBack(initialRouter)).toBe(false);
  });

  it("go pushes a screen and enables back", () => {
    const s = routerReducer(initialRouter, { type: "go", screen: { name: "runsList" } });
    expect(currentScreen(s).name).toBe("runsList");
    expect(s.stack).toHaveLength(2);
    expect(canGoBack(s)).toBe(true);
  });

  it("back pops to the previous screen", () => {
    let s: RouterState = routerReducer(initialRouter, { type: "go", screen: { name: "runsList" } });
    s = routerReducer(s, { type: "back" });
    expect(currentScreen(s).name).toBe("launcher");
    expect(canGoBack(s)).toBe(false);
  });

  it("back at the root is a no-op", () => {
    const s = routerReducer(initialRouter, { type: "back" });
    expect(currentScreen(s).name).toBe("launcher");
    expect(s.stack).toHaveLength(1);
  });

  it("replace swaps the top without growing the stack", () => {
    let s: RouterState = routerReducer(initialRouter, {
      type: "go",
      screen: { name: "form", command: "explore" },
    });
    s = routerReducer(s, { type: "replace", screen: { name: "runsList" } });
    expect(currentScreen(s).name).toBe("runsList");
    expect(s.stack).toHaveLength(2);
  });

  it("does not mutate the input state", () => {
    const before = JSON.stringify(initialRouter);
    routerReducer(initialRouter, { type: "go", screen: { name: "runsList" } });
    expect(JSON.stringify(initialRouter)).toBe(before);
  });
});
