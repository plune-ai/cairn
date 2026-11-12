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
