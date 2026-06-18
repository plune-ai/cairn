import { render } from "ink-testing-library";
import { describe, it, expect, vi } from "vitest";

const { useSessions } = vi.hoisted(() => ({ useSessions: vi.fn() }));
vi.mock("../../../src/tui/hooks/use-sessions.js", () => ({ useSessions }));

import { SessionPicker } from "../../../src/tui/components/session-picker.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("SessionPicker", () => {
  it("shows a loading line while sessions are being scanned", () => {
    useSessions.mockReturnValue({ names: [], loading: true });
    const { lastFrame, unmount } = render(<SessionPicker onSelect={vi.fn()} />);
    expect(lastFrame() ?? "").toContain("loading sessions");
    unmount();
  });

  it("offers (no session) + named sessions, and selecting none yields undefined", async () => {
    useSessions.mockReturnValue({ names: ["acme"], loading: false });
    const onSelect = vi.fn();
    const { lastFrame, stdin, unmount } = render(<SessionPicker onSelect={onSelect} />);
    await delay(30);
    const f = lastFrame() ?? "";
    expect(f).toContain("(no session)");
    expect(f).toContain("acme");
    stdin.write("\r"); // first item is "(no session)" → empty value → undefined
    await delay(30);
    expect(onSelect).toHaveBeenCalledWith(undefined);
    unmount();
  });
});
