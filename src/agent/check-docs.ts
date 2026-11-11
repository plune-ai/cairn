/**
 * #231 — `cairn check-docs`: walk the app as `collect-docs` does (#24) and compare what it sees with the docs.
 *
 * The walk makes no LLM call: only facts are compared (screens, overlays, fields, controls and where they lead), and
 * those are read from the ARIA snapshot. The UI side is rendered in the docs format and read back with the docs reader
 * (`documentarian/check.ts`), so both sides go through one parser. With `--spec`, the API operations the app called
 * while it was walked (`openapi.derived.json`, #229) are compared with the spec's.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ingestOpenApi } from "../api/openapi.js";
import { defaultRunsBaseDir } from "../fs/run-dir.js";
import { DOCS_FILE, renderDocsMd } from "../documentarian/docs.js";
import {
  compareApi,
  compareDocs,
  docsFileIn,
  mismatchCount,
  parseDocsMd,
  renderCheckMd,
  type CheckReport,
  type ReadSection,
} from "../documentarian/check.js";
import { walkApp, type WalkInput } from "./collect-docs.js";

export const CHECK_REPORT_FILE = "check-docs.md";

export interface CheckDocsInput extends WalkInput {
  /** A docs file in the collect-docs format, or a directory holding `docs.md`. */
  docs: string;
  /** An OpenAPI 3.x spec (JSON or YAML file) to compare with the traffic of the walk. */
  spec?: string;
  /** The run's directory (default `runs/check-docs-<id>/`). */
  out?: string;
}

export interface CheckDocsResult {
  outDir: string;
  reportFile: string;
  report: CheckReport;
  /** What fails the run: UI mismatches plus API operations the spec does not have. 0: the docs match. */
  mismatches: number;
}

/** The docs as sections, or a one-line error that says what was expected. Read before the walk, so a wrong path costs no browser. */
export async function readDocs(path: string): Promise<{ file: string; sections: ReadSection[] }> {
  if (/^https?:\/\//i.test(path)) throw new Error(`--docs takes a file or a directory, not an address (${path}).`);
  const full = resolve(path);
  const st = await stat(full).catch(() => undefined);
  if (!st) throw new Error(`No docs at ${path}.`);
  const file = docsFileIn(st.isDirectory(), full);
  const md = await readFile(file, "utf8").catch(() => {
    throw new Error(`No ${DOCS_FILE} in ${path}.`);
  });
  const sections = parseDocsMd(md);
  if (sections.length === 0) {
    throw new Error(`No sections in ${file}: check-docs reads the format \`cairn collect-docs\` writes ("## Screen: <title>" and so on; see docs/collect-docs.md).`);
  }
  return { file, sections };
}

export async function runCheckDocs(input: CheckDocsInput): Promise<CheckDocsResult> {
  const docs = await readDocs(input.docs);
  const spec = input.spec ? await ingestOpenApi(resolve(input.spec)) : undefined;
  const outDir = input.out ? resolve(input.out) : join(defaultRunsBaseDir(), `check-docs-${randomUUID()}`);

  const walk = await walkApp(input, outDir);
  const ui = parseDocsMd(renderDocsMd(walk.docs.model));
  const traffic = walk.openApiFile ? (await ingestOpenApi(walk.openApiFile)).endpoints : [];
  const screens = ui.filter((s) => s.kind === "Screen").length;
  const report: CheckReport = {
    origin: walk.docs.model.origin,
    docsLink: relative(outDir, docs.file).replace(/\\/g, "/"),
    screens,
    overlays: ui.length - screens,
    mismatches: compareDocs(docs.sections, ui),
    ...(spec ? { api: compareApi(spec.endpoints, traffic) } : {}),
  };
  await mkdir(outDir, { recursive: true });
  const reportFile = join(outDir, CHECK_REPORT_FILE);
  await writeFile(reportFile, renderCheckMd(report), "utf8");
  return { outDir, reportFile, report, mismatches: mismatchCount(report) };
}
