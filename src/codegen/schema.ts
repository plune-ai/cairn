import { z } from "zod";

export const FileBlobSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type FileBlob = z.infer<typeof FileBlobSchema>;

export const GeneratedSuiteSchema = z.object({
  files: z.array(FileBlobSchema).min(1),
});
export type GeneratedSuite = z.infer<typeof GeneratedSuiteSchema>;
