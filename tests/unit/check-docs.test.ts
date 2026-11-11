import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDocsMd, type DocSection, type DocsModel } from "../../src/documentarian/docs.js";
import { MATCH_LINE, compareApi, compareDocs, controlOf, headingAnchor, mismatchCount, operationsOf, parseDocsMd, renderCheckMd } from "../../src/documentarian/check.js";
import { readDocs } from "../../src/agent/check-docs.js";

/** #231: the pure parts of `cairn check-docs` — reading the docs format back, comparing, the report. */

const section = (s: Partial<DocSection> & Pick<DocSection, "kind" | "title">): DocSection => ({
  purpose: "",
  arrival: [],
  exits: [],
  completes: [],
  fields: [],
  userCan: [],
  userMight: [],
  steps: [],
  ...s,
});

/** The app as collect-docs would write it: two screens, a dialog opened from one. */
const model = (): DocsModel => ({
  origin: "http://a.test",
  questions: ['Screen "Home": What does "SLA" mean?'],
  sections: [
    section({
      kind: "Screen",
      title: "Home",
      address: "/",
      screenshot: "screenshots/01-home.png",
      arrival: ["the start address"],
      userCan: ['Go to Screen "Projects" — link "Projects"', 'Follow the link "Help" (https://help.test/)'],
    }),
    section({
      kind: "Screen",
      title: "Projects",
      address: "/projects",
      screenshot: "screenshots/02-projects.png",
      fields: [{ name: "Filter", role: "searchbox", required: false }],
      userCan: ['Go to Screen "Home" — link "Home"', 'Open Dialog "New project" — button "New project"', 'Press "Export"', "Press (unnamed button)"],
    }),
    section({
      kind: "Dialog",
      title: "New project",
      arrival: ['Screen "Projects" — button "New project"'],
      fields: [
        { name: "Project name", role: "textbox", required: true },
        { name: "Description", role: "textbox", required: false },
      ],
      userCan: ['Choose "Template"'],
    }),
  ],
});
const read = (m: DocsModel) => parseDocsMd(renderDocsMd(m));

describe("reading the docs format back", () => {
  it("reads each control form of User can", () => {
    expect(controlOf('Go to Screen "Settings" — link "Settings"')).toEqual({ type: "control", role: "link", name: "Settings", target: 'Screen "Settings"' });
    expect(controlOf('Open Wizard "Setup" — button "Start setup"')).toEqual({ type: "control", role: "button", name: "Start setup", target: 'Wizard "Setup"' });
    expect(controlOf('Follow the link "Docs" (https://d.test/)')).toEqual({ type: "control", role: "link", name: "Docs" });
    expect(controlOf('Press "Export"')).toEqual({ type: "control", role: "button", name: "Export" });
    expect(controlOf("Press (unnamed button)")).toEqual({ type: "control", role: "button", name: "" });
    expect(controlOf('Switch to the tab "Billing"')).toEqual({ type: "control", role: "tab", name: "Billing" });
    expect(controlOf('Choose "Rename"')).toEqual({ type: "control", role: "menuitem", name: "Rename" });
    expect(controlOf('Use the slider "Volume"')).toEqual({ type: "control", role: "slider", name: "Volume" });
    expect(controlOf("Talk to your admin first")).toBeUndefined();
  });

  it("reads sections, addresses, openers, screenshots, fields and controls; not the Questions", () => {
    const s = read(model());
    expect(s.map((x) => `${x.kind}: ${x.title} #${x.anchor}`)).toEqual(["Screen: Home #screen-home", "Screen: Projects #screen-projects", "Dialog: New project #dialog-new-project"]);
    expect(s[1]).toMatchObject({ address: "/projects", screenshot: "screenshots/02-projects.png" });
    expect(s[1]!.items).toEqual([
      { type: "field", role: "searchbox", name: "Filter" },
      { type: "control", role: "link", name: "Home", target: 'Screen "Home"' },
      { type: "control", role: "button", name: "New project", target: 'Dialog "New project"' },
      { type: "control", role: "button", name: "Export" },
      { type: "control", role: "button", name: "" },
    ]);
    expect(s[2]!.openedFrom).toEqual(['Screen "Projects" — button "New project"']);
  });

  it("anchors like GitHub, and numbers a repeated heading", () => {
    expect(headingAnchor("Dialog: New project")).toBe("dialog-new-project");
    expect(headingAnchor("Screen: Налаштування")).toBe("screen-налаштування");
    const twice = parseDocsMd("## Menu: More\n\n## Menu: More\n");
    expect(twice.map((x) => x.anchor)).toEqual(["menu-more", "menu-more-1"]);
  });
});

describe("compareDocs", () => {
  it("finds nothing when the docs are what the UI shows", () => {
    expect(compareDocs(read(model()), read(model()))).toEqual([]);
  });

  it("finds the three kinds: in the docs only, in the UI only, a name that differs — and nothing else", () => {
    const docs = model();
    docs.sections[1]!.userCan.push('Press "Archive"'); // the UI has no Archive
    docs.sections[1]!.fields = []; // the UI has a Filter field
    docs.sections[2]!.fields[0]!.name = "Name"; // the UI says "Project name"
    const found = compareDocs(read(docs), read(model()));
    expect(found).toHaveLength(3);
    expect(found).toContainEqual({ kind: "missing-in-ui", section: 'Screen "Projects"', anchor: "screen-projects", screenshot: "screenshots/02-projects.png", what: 'button "Archive"' });
    expect(found).toContainEqual({ kind: "missing-in-docs", section: 'Screen "Projects"', anchor: "screen-projects", screenshot: "screenshots/02-projects.png", what: 'field "Filter" (searchbox)' });
    expect(found).toContainEqual({ kind: "differs", section: 'Dialog "New project"', anchor: "dialog-new-project", what: "the name of a textbox field", docs: "Name", ui: "Project name" });
  });

  it("a renamed screen is one difference, not one per link to it", () => {
    const docs = model();
    docs.sections[1]!.title = "My projects";
    docs.sections[0]!.userCan[0] = 'Go to Screen "My projects" — link "Projects"';
    docs.sections[2]!.arrival = ['Screen "My projects" — button "New project"'];
    expect(compareDocs(read(docs), read(model()))).toEqual([
      { kind: "differs", section: 'Screen "My projects"', anchor: "screen-my-projects", screenshot: "screenshots/02-projects.png", what: "the screen's title", docs: "My projects", ui: "Projects" },
    ]);
  });

  it("a renamed overlay is paired by what opens it", () => {
    const docs = model();
    docs.sections[2]!.title = "Create project";
    docs.sections[1]!.userCan[1] = 'Open Dialog "Create project" — button "New project"';
    expect(compareDocs(read(docs), read(model()))).toEqual([
      { kind: "differs", section: 'Dialog "Create project"', anchor: "dialog-create-project", what: "the overlay's title", docs: "Create project", ui: "New project" },
    ]);
  });

  it("a link that leads elsewhere differs; a whole section missing on either side is said once", () => {
    const docs = model();
    docs.sections[0]!.userCan[0] = 'Go to Screen "Home" — link "Projects"';
    docs.sections.push(section({ kind: "Screen", title: "Billing", address: "/billing" }));
    const ui = model();
    ui.sections.splice(2, 1); // the dialog is gone from the UI
    ui.sections[1]!.userCan[1] = 'Press "New project"';
    const found = compareDocs(read(docs), read(ui));
    expect(found).toContainEqual({ kind: "differs", section: 'Screen "Home"', anchor: "screen-home", screenshot: "screenshots/01-home.png", what: 'where link "Projects" leads', docs: 'Screen "Home"', ui: 'Screen "Projects"' });
    expect(found).toContainEqual({ kind: "missing-in-ui", section: 'Screen "Billing"', anchor: "screen-billing", what: "the section itself" });
    expect(found).toContainEqual({ kind: "missing-in-ui", section: 'Dialog "New project"', anchor: "dialog-new-project", what: "the section itself" });
    expect(found).toHaveLength(3);
  });

  it("a section the docs lack is in the UI only, with its screen", () => {
    const ui = model();
    ui.sections.push(section({ kind: "Screen", title: "Billing", address: "/billing", screenshot: "screenshots/04-billing.png" }));
    expect(compareDocs(read(model()), read(ui))).toEqual([{ kind: "missing-in-docs", section: 'Screen "Billing"', screenshot: "screenshots/04-billing.png", what: "the section itself" }]);
  });
});

describe("the API", () => {
  it("compares operations with parameter names left out", () => {
    expect(operationsOf([{ method: "get", path: "/p/{projectId}" }, { method: "GET", path: "/p/{id}" }])).toEqual(["GET /p/{}"]);
    expect(compareApi([{ method: "GET", path: "/p/{projectId}" }, { method: "POST", path: "/p" }], [{ method: "GET", path: "/p/{id}" }, { method: "GET", path: "/health" }])).toEqual({
      notInSpec: ["GET /health"],
      notSeen: ["POST /p"],
    });
  });
});

describe("renderCheckMd", () => {
  it("says the docs match, with every heading present", () => {
    const md = renderCheckMd({ origin: "http://a.test", docsLink: "../docs/docs.md", screens: 2, overlays: 1, mismatches: [], api: { notInSpec: [], notSeen: ["POST /p"] } });
    expect(md).toContain(`**${MATCH_LINE}**`);
    for (const h of ["## In the docs, not in the UI", "## In the UI, not in the docs", "## Name differs", "## API: in the traffic, not in the spec", "## API: in the spec, not seen in the traffic"]) expect(md).toContain(h);
    expect(md).toContain("- `POST /p`");
  });

  it("links each mismatch to its docs section and its screen, and counts the API ones", () => {
    const r = {
      origin: "http://a.test",
      docsLink: "../docs/docs.md",
      screens: 2,
      overlays: 1,
      mismatches: [{ kind: "differs" as const, section: 'Dialog "New project"', anchor: "dialog-new-project", screenshot: "screenshots/02-p.png", what: "the name of a textbox field", docs: "Name", ui: "Project name" }],
      api: { notInSpec: ["GET /health"], notSeen: [] },
    };
    expect(mismatchCount(r)).toBe(2);
    const md = renderCheckMd(r);
    expect(md).toContain("**2 mismatch(es) between the docs and the UI.**");
    expect(md).toContain('- [Dialog "New project"](../docs/docs.md#dialog-new-project): the name of a textbox field: "Name" in the docs, "Project name" in the UI — [screen](screenshots/02-p.png)');
    expect(md).toContain("- `GET /health`");
  });
});

describe("readDocs", () => {
  let dir: string;
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("takes a file or a directory with docs.md, and says what it expected otherwise", async () => {
    dir = await mkdtemp(join(tmpdir(), "cairn-check-"));
    await writeFile(join(dir, "docs.md"), renderDocsMd(model()), "utf8");
    expect((await readDocs(dir)).sections).toHaveLength(3);
    expect((await readDocs(join(dir, "docs.md"))).sections).toHaveLength(3);
    await writeFile(join(dir, "other.md"), "# Notes\n\nJust text.\n", "utf8");
    await expect(readDocs(join(dir, "other.md"))).rejects.toThrow(/^No sections in .*other\.md: check-docs reads the format `cairn collect-docs` writes/);
    await expect(readDocs(join(dir, "nope"))).rejects.toThrow(/^No docs at /);
    await expect(readDocs("https://docs.test/")).rejects.toThrow(/takes a file or a directory, not an address/);
  });
});
