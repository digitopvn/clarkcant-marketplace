import { z } from "zod";

import { semverSchema } from "./manifest";
import { packageNameSchema } from "./packages";

export const submissionStatusSchema = z.enum(["queued", "indexing", "indexed", "failed"]);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

/** Ask the marketplace to (re)index an npm package. Omitting `version` means "the current `latest` dist-tag". */
export const submitPackageInputSchema = z.object({
  packageName: packageNameSchema,
  version: semverSchema.optional(),
});
export type SubmitPackageInput = z.infer<typeof submitPackageInputSchema>;

export const submissionSchema = z.object({
  id: z.string(),
  packageName: z.string(),
  version: z.string().nullable(),
  status: submissionStatusSchema,
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Submission = z.infer<typeof submissionSchema>;

/** Message placed on the ingest queue. Kept minimal: consumers re-read state from D1 rather than trusting it. */
export const ingestMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("index-package"), submissionId: z.string().min(1), packageName: packageNameSchema }),
  z.object({ type: z.literal("discover"), source: z.literal("npm-search") }),
]);
export type IngestMessage = z.infer<typeof ingestMessageSchema>;
