import { describe, it, expect } from "vitest";
import { parseAriaSnapshot } from "../../src/observe/parse-aria.js";

// Real output of page.ariaSnapshot() from tests/fixtures/site/login.html.
const LOGIN_ARIA = `- main:
  - heading "Sign in" [level=1]
  - text: Email
  - textbox "Email"
  - text: Password
  - textbox "Password"
  - checkbox "Remember me"
  - text: Remember me
  - button "Sign In"
  - status
  - navigation:
    - link "View list":
      - /url: /list.html
    - link "Open modal page":
      - /url: /modal.html`;

describe("parseAriaSnapshot", () => {
  const els = parseAriaSnapshot(LOGIN_ARIA);

  it("extracts interactive elements with role and name", () => {
    const email = els.find((e) => e.role === "textbox" && e.name === "Email");
    expect(email?.interactive).toBe(true);
    const signIn = els.find((e) => e.role === "button" && e.name === "Sign In");
    expect(signIn?.interactive).toBe(true);
    const remember = els.find((e) => e.role === "checkbox");
    expect(remember?.name).toBe("Remember me");
    expect(remember?.interactive).toBe(true);
  });

  it("links are interactive, named by text (not by URL)", () => {
    const link = els.find((e) => e.role === "link" && e.name === "View list");
    expect(link?.interactive).toBe(true);
  });

  it("heading/landmark are not interactive", () => {
    const heading = els.find((e) => e.role === "heading");
    expect(heading?.name).toBe("Sign in");
    expect(heading?.interactive).toBe(false);
  });

  it("skips property lines (/url) and text nodes (text:)", () => {
    expect(els.some((e) => e.role === "text")).toBe(false);
    expect(els.some((e) => e.role.startsWith("/"))).toBe(false);
    expect(els.some((e) => e.name === "/list.html")).toBe(false);
  });

  it("refs are unique and start at e1", () => {
    const refs = els.map((e) => e.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs[0]).toBe("e1");
  });

  it("interactive elements rank higher than a heading", () => {
    const btn = els.find((e) => e.role === "button");
    const heading = els.find((e) => e.role === "heading");
    expect(btn?.rank ?? 0).toBeGreaterThan(heading?.rank ?? 0);
  });

  it("empty input → []", () => {
    expect(parseAriaSnapshot("")).toEqual([]);
  });

  it("uses the native [ref=...] when present (cli/MCP snapshot)", () => {
    const cli = parseAriaSnapshot('- button "Go" [ref=e15]\n- textbox "Query" [ref=e9]');
    expect(cli.find((e) => e.role === "button")?.ref).toBe("e15");
    expect(cli.find((e) => e.role === "textbox")?.ref).toBe("e9");
  });
});
