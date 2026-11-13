import { z } from "zod";
import { nameSchema } from "../llm/structured.js";

export const FileBlobSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type FileBlob = z.infer<typeof FileBlobSchema>;

export const GeneratedSuiteSchema = nameSchema(z.object({
  files: z.array(FileBlobSchema).min(1),
}), "GeneratedSuite");
export type GeneratedSuite = z.infer<typeof GeneratedSuiteSchema>;

/**
 * The model's reply: the files plus, per file, which listed case each test() covers. The generator turns that map
 * into a Playwright annotation ({@link CASE_ANNOTATION}) on the test, so a test keeps its case whatever its title.
 */
export const CodegenReplySchema = nameSchema(z.object({
  files: z.array(FileBlobSchema.extend({
    cases: z
      .array(z.object({ test: z.string(), caseId: z.string() }))
      .default([])
      .describe("One entry per test() in this file: its exact title and the id of the listed case it covers"),
  })).min(1),
}), "GeneratedSuite");
export type CodegenReply = z.infer<typeof CodegenReplySchema>;

/** The Playwright annotation type that carries a generated test's case `stableId` (read back into `screencasts.json`). */
export const CASE_ANNOTATION = "stableId";
