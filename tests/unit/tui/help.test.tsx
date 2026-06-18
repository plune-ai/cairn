import { render } from "ink-testing-library";
import { describe, it, expect } from "vitest";
import { Help } from "../../../src/tui/components/help.js";

describe("Help", () => {
  it("shows the esc-back hint when back navigation is possible", () => {
    const { lastFrame, unmount } = render(<Help canGoBack={true} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("esc back");
    expect(f).toContain("q quit");
    unmount();
  });

  it("omits the esc-back hint at the root (nothing to go back to)", () => {
    const { lastFrame, unmount } = render(<Help canGoBack={false} />);
    const f = lastFrame() ?? "";
    expect(f).not.toContain("esc back");
    expect(f).toContain("q quit"); // quit is always offered
    unmount();
  });
});
