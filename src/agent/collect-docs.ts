/**
 * #24 — `cairn collect-docs`: write an app's user docs by walking its UI, so testing can start on a product that has
 * none.
 *
 * The walk is the explorer's own machinery, not a second crawler: the screens are the pages `crawlFlow` reaches by the
 * app's links (same origin, no sign-out or deletion link), and the overlays of each screen are the states
 * `exploreOverlays` finds (#225) — under its write guard, so documenting changes nothing on the server. What is read
 * from the ARIA snapshot (fields, required fields, what can be pressed, where it leads, the ways out of an overlay, the
 * steps of a wizard) is deterministic. One LLM call per screen says what the screen and its overlays are for and lists
 * what it could not explain as questions; its answer is cached by what the walk saw (ADR-0018), so a second walk of an
 * unchanged screen makes no call. The app's API requests seen on the way become `openapi.derived.json` (#229).
 */
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { makeGateway, type BrowserGateway, type StorageState } from "../browser/index.js";
import { ApiTrafficRecorder, parseApiOrigins, writeTrafficSpec } from "../browser/api-traffic.js";
import { ensureBrowsersInstalled } from "../browser/preflight.js";
import { DERIVED_SPEC_FILE } from "../api/derived.js";
import { secretValues } from "../decider/redact.js";
import { CallBudget, RoleRouter, type CostReport, type StructuredInvoke } from "../llm/index.js";
import { PromptRegistry } from "../prompts/index.js";
import { SessionStore } from "../session/index.js";
import { capture, type PageStudy } from "../observe/index.js";
import { formatOverlays, type OverlayState } from "../observe/overlays.js";
import { crawlFlow, norm } from "../flow/crawl.js";
import { defaultRunsBaseDir } from "../fs/run-dir.js";
import {
  DOCS_FILE,
  NO_DESCRIPTION,
  SCREENSHOTS_DIR,
  ScreenDescriptionSchema,
  abbreviationsIn,
  fieldsOf,
  isField,
  loadDescription,
  overlayExitsOf,
  overlayKind,
  overlaySaidNames,
  questionsFor,
  renderDocsMd,
  saveDescription,
  screenFingerprint,
  screenTitle,
  sectionRef,
  userCanOf,
  wizardStepsOf,
  type DocSection,
  type DocsModel,
  type ScreenDescription,
} from "../documentarian/docs.js";
import type { AppConfig } from "../config/index.js";
import { describeObserveError, findConsentDismiss } from "./observe-guard.js";
import { exploreOverlays } from "./overlays.js";

/** Screens walked unless `--max-pages` says otherwise (cost guardrail: one LLM call per new or changed screen). */
export const DEFAULT_MAX_SCREENS = 10;
/** The longest ARIA snapshot sent to the model, in characters. */
const MAX_ARIA_CHARS = 12_000;

export interface CollectDocsDeps {
  gateway: BrowserGateway;
  prompts: PromptRegistry;
  describeInvoke: StructuredInvoke;
  /** Where screen descriptions are cached across runs; undefined: no cache. */
  cacheDir?: string;
  /** Ignore the cache (describe every screen again). */
  fresh?: boolean;
  maxScreens?: number;
  language?: string;
  onProgress?: (event: string) => void;
}

export interface CollectedDocs {
  model: DocsModel;
  /** Screenshots to write, each at its path relative to the docs file. */
  screenshots: { path: string; b64: string }[];
  /** Screens described by the model in this run, and those whose description came from the cache. */
  described: number;
  cached: number;
}

/** The start page shows nothing a user could read about or do. */
export function emptyAppMessage(url: string): string {
  return `Nothing to document at ${url}: the page shows no heading and no control. Check the address, or pass --session if the app needs a sign-in.`;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "screen";
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
const address = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/** The walk: screens, their overlays, their descriptions. Throws a one-line error on an unreachable or empty app. */
export async function collectDocs(deps: CollectDocsDeps, url: string): Promise<CollectedDocs> {
  const { gateway } = deps;
  const say = deps.onProgress ?? (() => undefined);

  say("collect-docs — opening the app…");
  let study: PageStudy;
  try {
    study = await capture(gateway, url);
  } catch (e) {
    throw new Error(describeObserveError(e, url));
  }
  const consent = findConsentDismiss(study.elements);
  if (consent) {
    try {
      if ((await gateway.act({ kind: "click", ref: consent.ref })).ok) study = await capture(gateway, "");
    } catch {
      // best effort, as in explore
    }
  }
  if (!study.elements.some((e) => e.interactive || e.role === "heading")) throw new Error(emptyAppMessage(url));

  const maxScreens = deps.maxScreens ?? DEFAULT_MAX_SCREENS;
  say(`collect-docs — following the app's links (up to ${maxScreens} screens)…`);
  const graph = await crawlFlow({ url: study.url, study, verified: [], transitions: [] }, { gateway, onProgress: say }, { maxPages: maxScreens });

  // Titles first: a link anywhere may lead to any screen. Two screens with one title are told apart by a number.
  const titles: string[] = [];
  for (const n of graph.nodes) {
    const t = screenTitle(n.study.ariaYaml, n.url);
    const same = titles.filter((x) => x === t || x.startsWith(`${t} (`)).length;
    titles.push(same ? `${t} (${same + 1})` : t);
  }
  const screenRefs = titles.map((title) => sectionRef({ kind: "Screen", title }));
  const indexOf = new Map(graph.nodes.map((n, i) => [norm(n.url), i]));

  const sections: DocSection[] = [];
  const questions: string[] = [];
  const screenshots: CollectedDocs["screenshots"] = [];
  const overlayByKey = new Map<string, DocSection>();
  let described = 0;
  let cached = 0;

  for (const [i, node] of graph.nodes.entries()) {
    const title = titles[i]!;
    const screenRef = screenRefs[i]!;
    say(`collect-docs — screen ${i + 1}/${graph.nodes.length}: ${title}`);
    // The crawler's page on this screen: required fields are read here, and exploreOverlays reads its triggers here.
    await gateway.observe({ url: node.url });
    const own = node.study.elements.filter((e) => e.interactive && !e.inside && !e.scope && !e.underOverlay);
    const required = new Set<string>();
    for (const f of own.filter((e) => isField(e.role) && e.name)) {
      if ((await gateway.getState(f).catch(() => undefined))?.required) required.add(f.name!);
    }

    const seen = new Map<OverlayState, { screenshotB64: string; required: Set<string> }>();
    let states: OverlayState[] = [];
    try {
      const found = await exploreOverlays({
        gateway,
        url: node.url,
        study: node.study,
        onProgress: say,
        onOverlay: async (state, open) => {
          const req = new Set<string>();
          for (const e of open.elements.filter((x) => isField(x.role) && x.name)) {
            if ((await gateway.getState(e).catch(() => undefined))?.required) req.add(e.name!);
          }
          seen.set(state, { screenshotB64: open.screenshotB64, required: req });
        },
      });
      states = found.states;
    } catch (e) {
      say(`collect-docs — the overlays of ${title} were not explored (${firstLine(e)})`);
    }

    const description = await describe(deps, { url: node.url, title, aria: node.study.ariaYaml, states }, (hit) => (hit ? cached++ : described++));

    // What each overlay is called in the docs, and which control opens it.
    const refById = new Map<string, string>();
    const opensOnScreen = new Map<string, string>();
    const opensIn = new Map<string, Map<string, string>>();
    const titleOf = (st: OverlayState): string => st.name ?? `${overlayKind(st).toLowerCase()} on ${title}`;
    for (const st of states) {
      const ref = sectionRef({ kind: overlayKind(st), title: titleOf(st) });
      refById.set(st.id, ref);
      if (!st.trigger.name || st.trigger.role === "page") continue;
      const target = st.parent ? (opensIn.get(st.parent) ?? opensIn.set(st.parent, new Map()).get(st.parent)!) : opensOnScreen;
      target.set(st.trigger.name, ref);
    }

    const links = new Map<string, string>();
    for (const e of graph.edges) {
      const to = indexOf.get(norm(e.to));
      if (norm(e.from) === norm(node.url) && to !== undefined && e.via.name) links.set(e.via.name, screenRefs[to]!);
    }
    for (const e of own) {
      if (e.role !== "link" || !e.name || !e.url || links.has(e.name)) continue;
      try {
        const to = indexOf.get(norm(new URL(e.url, node.url).toString()));
        if (to !== undefined) links.set(e.name, screenRefs[to]!);
      } catch {
        // not an address
      }
    }

    const arrival = i === 0 ? ["the start address"] : [];
    for (const e of graph.edges) {
      const from = indexOf.get(norm(e.from));
      if (norm(e.to) !== norm(node.url) || from === undefined || from === i) continue;
      const line = `${screenRefs[from]} — link "${e.via.name ?? ""}"`;
      if (!arrival.includes(line)) arrival.push(line);
    }

    const shot = `${SCREENSHOTS_DIR}/${pad(i + 1)}-${slug(title)}.png`;
    if (node.study.screenshotB64) screenshots.push({ path: shot, b64: node.study.screenshotB64 });
    const screen: DocSection = {
      kind: "Screen",
      title,
      ...(node.study.screenshotB64 ? { screenshot: shot } : {}),
      address: address(node.url),
      purpose: description.purpose,
      arrival,
      exits: [],
      completes: [],
      fields: fieldsOf(own, required),
      userCan: userCanOf(own, { links, opens: opensOnScreen }),
      userMight: description.userMight,
      steps: [],
    };
    sections.push(screen);
    questions.push(...questionsFor(screen, abbreviationsIn(node.study.ariaYaml), description.questions));

    for (const st of states) {
      const kind = overlayKind(st);
      const otitle = titleOf(st);
      const from = st.parent ? (refById.get(st.parent) ?? screenRef) : screenRef;
      const opened = st.trigger.role === "page" ? `open when ${screenRef} loads` : `${from} — ${st.trigger.role} "${st.trigger.name ?? ""}"`;
      // ponytail: one section per kind and title across screens (a header menu on every page); two different dialogs
      // with one title merge too. A content fingerprint per overlay when that bites.
      const key = `${kind}\u0000${otitle}`;
      const known = overlayByKey.get(key);
      if (known) {
        if (!known.arrival.includes(opened)) known.arrival.push(opened);
        continue;
      }
      const said = description.overlays.find((o) => o.id === st.id);
      const open = seen.get(st);
      const file = `${SCREENSHOTS_DIR}/${pad(i + 1)}-${slug(title)}-${st.id}.png`;
      if (open?.screenshotB64) screenshots.push({ path: file, b64: open.screenshotB64 });
      const section: DocSection = {
        kind,
        title: otitle,
        ...(open?.screenshotB64 ? { screenshot: file } : {}),
        purpose: said?.purpose ?? "",
        arrival: [opened],
        ...overlayExitsOf(st),
        fields: fieldsOf(st.elements, open?.required ?? new Set()),
        userCan: userCanOf(st.elements, { opens: opensIn.get(st.id) ?? new Map() }, overlaySaidNames(st)),
        userMight: said?.userMight ?? [],
        steps: wizardStepsOf(st),
      };
      overlayByKey.set(key, section);
      sections.push(section);
      questions.push(...questionsFor(section, abbreviationsIn(st.elements.map((e) => e.name ?? "").join("\n")), []));
    }
  }

  let origin = study.url;
  try {
    origin = new URL(study.url).origin;
  } catch {
    // keep the address as it is
  }
  return { model: { origin, sections, questions: [...new Set(questions)] }, screenshots, described, cached };
}

/** The description of one screen: from the cache when it saw the same, else from the model (and cached). Never throws. */
async function describe(
  deps: CollectDocsDeps,
  screen: { url: string; title: string; aria: string; states: OverlayState[] },
  count: (cacheHit: boolean) => void,
): Promise<ScreenDescription> {
  const say = deps.onProgress ?? (() => undefined);
  const overlays = formatOverlays(screen.states) || "(none)";
  const fingerprint = screenFingerprint(screen.aria, overlays);
  const hit = deps.cacheDir && !deps.fresh ? await loadDescription(deps.cacheDir, screen.url, fingerprint) : undefined;
  if (hit) {
    count(true);
    say(`collect-docs — ${screen.title}: unchanged, description reused (no LLM call)`);
    return hit;
  }
  try {
    const prompt = await deps.prompts.getPrompt("describe-screen", {
      language: deps.language ?? "English",
      url: screen.url,
      title: screen.title,
      aria: screen.aria.slice(0, MAX_ARIA_CHARS),
      overlays,
    });
    const description = await deps.describeInvoke(ScreenDescriptionSchema, [new HumanMessage(prompt.text)]);
    count(false);
    if (deps.cacheDir) await saveDescription(deps.cacheDir, screen.url, fingerprint, description);
    return description;
  } catch (e) {
    say(`collect-docs — ${screen.title}: not described (${firstLine(e)}); its facts are still written`);
    return NO_DESCRIPTION;
  }
}

export interface CollectDocsInput {
  url: string;
  config: AppConfig;
  sessionName?: string;
  sessionFile?: string;
  /** The run's directory (default `runs/docs-<id>/`). */
  out?: string;
  maxScreens?: number;
  fresh?: boolean;
  headed?: boolean;
  /** #229: origins besides `url`'s whose API requests go into openapi.derived.json (comma-separated). */
  apiOrigins?: string;
  /** Default `.cairn-cache/understanding` (descriptions go to its `screens/`). */
  cacheDir?: string;
  sessionsDir?: string;
  /** Injected in tests; else the worker role's model. */
  describeInvoke?: StructuredInvoke;
  onProgress?: (event: string) => void;
}

export interface CollectDocsResult {
  outDir: string;
  docsFile: string;
  /** Absent when the app made no API request the draft could use. */
  openApiFile?: string;
  model: DocsModel;
  described: number;
  cached: number;
  cost: CostReport;
}

/** `cairn collect-docs`: the walk, then `docs.md`, its screenshots and the OpenAPI draft in the run's directory. */
export async function runCollectDocs(input: CollectDocsInput): Promise<CollectDocsResult> {
  const cfg = input.config;
  ensureBrowsersInstalled({ channel: cfg.browser.channel });
  const onProgress = input.onProgress ?? (() => undefined);
  const router = new RoleRouter(cfg, { anthropicApiKey: cfg.anthropicApiKey, openrouterApiKey: cfg.openrouterApiKey, groqApiKey: cfg.groqApiKey }, new CallBudget(80));
  const apiTraffic = cfg.browser.backend === "lib" ? new ApiTrafficRecorder({ origins: parseApiOrigins(input.url, input.apiOrigins) }) : undefined;

  const sessions = new SessionStore(resolve(input.sessionsDir ?? ".auth"));
  let storageState: StorageState | undefined;
  if (input.sessionFile) storageState = await sessions.loadFile(resolve(input.sessionFile));
  else if (input.sessionName) storageState = await sessions.load(input.sessionName);

  const gateway = makeGateway({ backend: cfg.browser.backend, storageState, channel: cfg.browser.channel, headless: !input.headed, apiTraffic });
  try {
    const docs = await collectDocs(
      {
        gateway,
        prompts: new PromptRegistry(),
        describeInvoke: input.describeInvoke ?? router.invoke("worker", router.tierFor("worker", cfg.models.bulk)),
        cacheDir: resolve(input.cacheDir ?? ".cairn-cache/understanding"),
        fresh: input.fresh,
        maxScreens: input.maxScreens,
        language: cfg.testCaseLanguage,
        onProgress,
      },
      input.url,
    );
    const outDir = input.out ? resolve(input.out) : join(defaultRunsBaseDir(), `docs-${randomUUID()}`);
    await mkdir(join(outDir, SCREENSHOTS_DIR), { recursive: true });
    for (const s of docs.screenshots) await writeFile(join(outDir, s.path), Buffer.from(s.b64, "base64"));
    const docsFile = join(outDir, DOCS_FILE);
    await writeFile(docsFile, renderDocsMd(docs.model), "utf8");
    await writeTrafficSpec(apiTraffic, outDir, input.url, secretValues("", process.env), onProgress);
    const openApiFile = join(outDir, DERIVED_SPEC_FILE);
    const hasSpec = await access(openApiFile).then(
      () => true,
      () => false,
    );
    return {
      outDir,
      docsFile,
      ...(hasSpec ? { openApiFile } : {}),
      model: docs.model,
      described: docs.described,
      cached: docs.cached,
      cost: router.ledger.report(),
    };
  } finally {
    await gateway.close();
  }
}
