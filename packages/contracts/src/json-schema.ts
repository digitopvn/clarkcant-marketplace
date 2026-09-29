import { z } from "zod";

import { auditEventSchema } from "./audit";
import { errorBodySchema } from "./errors";
import { clarkcantManifestSchema, packageManifestSchema, widgetPackageManifestSchema } from "./manifest";
import { packageDetailSchema, packageSummarySchema } from "./packages";
import { pageDocumentSchema } from "./pages";
import { submissionSchema, submitPackageInputSchema } from "./submissions";

/** Contracts published as JSON Schema for non-TypeScript consumers (CLI users, agents, external indexers). */
const PUBLISHED_SCHEMAS = {
  "clarkcant-manifest": clarkcantManifestSchema,
  "clarkcant-install-manifest": packageManifestSchema,
  "clarkcant-widget-package-manifest": widgetPackageManifestSchema,
  "page-document": pageDocumentSchema,
  "package-summary": packageSummarySchema,
  "package-detail": packageDetailSchema,
  "submit-package-input": submitPackageInputSchema,
  submission: submissionSchema,
  "audit-event": auditEventSchema,
  "error-body": errorBodySchema,
} as const satisfies Record<string, z.ZodType>;

export type PublishedSchemaName = keyof typeof PUBLISHED_SCHEMAS;
export const PUBLISHED_SCHEMA_NAMES = Object.keys(PUBLISHED_SCHEMAS) as PublishedSchemaName[];

/**
 * JSON Schema (draft 2020-12) for one published contract. Input schemas describe what a client sends
 * (`io: "input"`), so defaults are optional there rather than required.
 */
export function toJsonSchema(name: PublishedSchemaName): Record<string, unknown> {
  const io = name === "submit-package-input" || name === "page-document" ? "input" : "output";
  return z.toJSONSchema(PUBLISHED_SCHEMAS[name], { io, unrepresentable: "any" }) as Record<string, unknown>;
}
