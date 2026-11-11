import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NO_DESCRIPTION,
  abbreviationsIn,
  fieldsOf,
  loadDescription,
  overlayExitsOf,
  overlayKind,
  overlaySaidNames,
  questionsFor,
  renderDocsMd,
  saveDescription,
  screenFingerprint,
  screenTitle,
  userCanOf,
  wizardStepsOf,
  type DocsModel,
} from "../../src/documentarian/docs.js";
import type { OverlayState } from "../../src/observe/overlays.js";

/** #24: the pure parts of `cairn collect-docs` — facts from ARIA, questions, the cache, the Markdown. */

describe("screenTitle", () => {
  it("takes the first level-1 heading, else the first heading, else the path", () => {
    expect(screenTitle('- heading "Intro" [level=2]\n- heading "Projects" [level=1]', "http://a.test/p")).toBe("Projects");
    expect(screenTitle('- heading "Intro" [level=2]', "http://a.test/p")).toBe("Intro");
    expect(screenTitle("- button \"Go\"", "http://a.test/app/settings")).toBe("/app/settings");
  });
});

describe("userCanOf / fieldsOf", () => {
  const controls = [
    { role: "link", name: "Settings" },
    { role: "link", name: "Docs", url: "https://docs.test/" },
    { role: "button", name: "New project" },
    { role: "button", name: "Export" },
    { role: "button", name: "Export" },
    { role: "textbox", name: "Project name" },
    { role: "checkbox", name: "Email alerts" },
    { role: "tab", name: "Billing" },
    { role: "menuitem", name: "Rename" },
    { role: "button" },
  ];

  it("says where a known link or trigger leads, leaves fields out, says each thing once", () => {
    const lines = userCanOf(controls, { links: new Map([["Settings", 'Screen "Settings"']]), opens: new Map([["New project", 'Dialog "New project"']]) });
    expect(lines).toEqual([
      'Go to Screen "Settings" — link "Settings"',
      'Follow the link "Docs" (https://docs.test/)',
      'Open Dialog "New project" — button "New project"',
      'Press "Export"',
      'Switch to the tab "Billing"',
      'Choose "Rename"',
      "Press (unnamed button)",
    ]);
  });

  it("skips names said elsewhere (an overlay's exits)", () => {
    expect(userCanOf([{ role: "button", name: "Cancel" }, { role: "button", name: "Apply" }], {}, new Set(["Cancel"]))).toEqual(['Press "Apply"']);
  });

  it("lists the fields, required as the DOM said", () => {
    expect(fieldsOf(controls, new Set(["Project name"]))).toEqual([
      { name: "Project name", role: "textbox", required: true },
      { name: "Email alerts", role: "checkbox", required: false },
    ]);
  });
});

const wizard: OverlayState = {
  id: "overlay-1",
  kind: "dialog",
  role: "dialog",
  name: "Setup wizard",
  modal: true,
  trigger: { role: "button", name: "Start setup" },
  exits: [
    { kind: "escape", verified: true },
    { kind: "close-button", name: "Close" },
    { kind: "cancel", name: "Cancel" },
    { kind: "click-outside", verified: false },
    { kind: "submit", name: "Delete all", safe: false },
  ],
  elements: [
    { role: "button", name: "Next", locator: "" },
    { role: "button", name: "Cancel", locator: "" },
    { role: "button", name: "Help", locator: "" },
  ],
  toasts: [],
  skipped: [],
  wizard: {
    steps: [
      { index: 0, headings: ["Step 1 of 2"], fields: ["Company"], nextBlocked: ["Company is required"] },
      { index: 1, headings: [], fields: [] },
    ],
    next: "Next",
    back: "Back",
    backWorks: true,
  },
};

describe("overlays", () => {
  it("names the kind: a wizard is a Wizard whatever its role", () => {
    expect(overlayKind(wizard)).toBe("Wizard");
    expect(overlayKind({ kind: "alertdialog" })).toBe("Alert dialog");
    expect(overlayKind({ kind: "drawer" })).toBe("Drawer");
  });

  it("keeps only verified probed exits, and marks a destructive completion", () => {
    expect(overlayExitsOf(wizard)).toEqual({
      exits: ["Escape", 'button "Close"', 'button "Cancel"'],
      completes: ['button "Delete all" (destructive; not pressed while documenting)'],
    });
  });

  it("does not repeat exits and step buttons under User can", () => {
    const said = overlaySaidNames(wizard);
    expect(userCanOf(wizard.elements, {}, said)).toEqual(['Press "Help"']);
  });

  it("writes one line per wizard step, with what blocked Next", () => {
    expect(wizardStepsOf(wizard)).toEqual([
      'Step 1 of 2 — fields: "Company"; Next is blocked until it is filled (the page says: "Company is required")',
      'Step 2; "Back" returns to the step before',
    ]);
    expect(wizardStepsOf({})).toEqual([]);
  });
});

describe("questions", () => {
  it("asks about abbreviations that are not common knowledge, outside addresses", () => {
    const aria = '- text: "Your SLA: 99.9% · MRR up · OK · API · ID"\n- link "KPI board":\n  - /url: /ZZTOP';
    expect(abbreviationsIn(aria)).toEqual(["SLA", "MRR", "KPI"]);
    expect(abbreviationsIn("- text: A B Q4 2026")).toEqual([]);
  });

  it("prefixes every question with its section, and says each one once", () => {
    expect(questionsFor({ kind: "Screen", title: "Home" }, ["SLA"], ['What does "SLA" mean?', " What is Tier 2? ", ""])).toEqual([
      'Screen "Home": What does "SLA" mean?',
      'Screen "Home": What is Tier 2?',
    ]);
  });
});

describe("the description cache", () => {
  let dir: string;
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hits on the same url and fingerprint only", async () => {
    dir = await mkdtemp(join(tmpdir(), "cairn-docs-"));
    const fp = screenFingerprint("- heading \"Home\"", "(none)");
    const d = { ...NO_DESCRIPTION, purpose: "The home screen." };
    await saveDescription(dir, "http://a.test/", fp, d);
    expect(await loadDescription(dir, "http://a.test/", fp)).toEqual(d);
    expect(await loadDescription(dir, "http://a.test/", screenFingerprint("- heading \"Home\"", "- overlay-1 · dialog"))).toBeUndefined();
    expect(await loadDescription(dir, "http://b.test/", fp)).toBeUndefined();
  });

  it("the fingerprint covers the overlays too", () => {
    expect(screenFingerprint("a", "x")).not.toBe(screenFingerprint("a", "y"));
    expect(screenFingerprint("a", "x")).toBe(screenFingerprint("a", "x"));
  });
});

describe("renderDocsMd", () => {
  it("writes the fixed format: a section per screen and overlay, then Questions", () => {
    const model: DocsModel = {
      origin: "http://a.test",
      sections: [
        {
          kind: "Screen",
          title: "Home",
          screenshot: "screenshots/01-home.png",
          address: "/",
          purpose: "",
          arrival: ["the start address"],
          exits: [],
          completes: [],
          fields: [{ name: "Search", role: "searchbox", required: true }],
          userCan: ['Open Dialog "Invite" — button "Invite"'],
          userMight: [],
          steps: [],
        },
        {
          kind: "Dialog",
          title: "Invite",
          purpose: "invite a teammate",
          arrival: ['Screen "Home" — button "Invite"'],
          exits: ["Escape"],
          completes: [],
          fields: [],
          userCan: [],
          userMight: ["add a colleague"],
          steps: [],
        },
      ],
      questions: ['Screen "Home": What does "SLA" mean?'],
    };
    expect(renderDocsMd(model)).toBe(
      [
        "# Docs: http://a.test",
        "",
        "Written by `cairn collect-docs` from what a walk of the app saw: 1 screen(s), 1 overlay(s), 1 question(s). Edit freely: each section is one screen or overlay. Anything the walk could not explain is under Questions, not guessed at.",
        "",
        "## Screen: Home",
        "",
        "![Screen: Home](screenshots/01-home.png)",
        "",
        "- Address: `/`",
        "- What it is: _Not described._",
        "- Who gets here: the start address",
        "",
        "**Fields**",
        "",
        '- "Search" — searchbox, required',
        "",
        "**User can**",
        "",
        '- Open Dialog "Invite" — button "Invite"',
        "",
        "**User might**",
        "",
        "_None._",
        "",
        "## Dialog: Invite",
        "",
        "- What it is: invite a teammate",
        '- Opened from: Screen "Home" — button "Invite"',
        "- Ways out: Escape",
        "- Completes with: _Nothing._",
        "",
        "**Fields**",
        "",
        "_None._",
        "",
        "**User can**",
        "",
        "_None._",
        "",
        "**User might**",
        "",
        "- add a colleague",
        "",
        "## Questions",
        "",
        '- Screen "Home": What does "SLA" mean?',
        "",
      ].join("\n"),
    );
  });
});
