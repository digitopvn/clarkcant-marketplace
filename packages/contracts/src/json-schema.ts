import { z } from "zod";

import { auditEventSchema } from "./audit";
import { errorBodySchema } from "./errors";
import {
  clarkcantManifestSchema,
  legacyInstallManifestSchema,
  packageManifestSchema,
  widgetPackageManifestSchema,
} from "./manifest";
import { packageDetailSchema, packageSummarySchema } from "./packages";
import { pageDocumentSchema } from "./pages";
import { submissionSchema, submitPackageInputSchema } from "./submissions";

/** Contracts published as JSON Schema for non-TypeScript consumers (CLI users, agents, external indexers). */
const PUBLISHED_SCHEMAS = {
  "clarkcant-manifest": clarkcantManifestSchema,
  /** The canonical `schemaVersion: 2` manifest. */
  "clarkcant-package-manifest": packageManifestSchema,
  /** The schemaVersion-less install draft, still read for compatibility. */
  "clarkcant-install-manifest": legacyInstallManifestSchema,
  /** The `schemaVersion: 1` widget-only manifest. */
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

/** Contracts a client or package author writes, described as input so fields with defaults stay optional. */
const INPUT_SCHEMAS: ReadonlySet<PublishedSchemaName> = new Set([
  "submit-package-input",
  "page-document",
  "clarkcant-manifest",
  "clarkcant-package-manifest",
  "clarkcant-install-manifest",
  "clarkcant-widget-package-manifest",
]);

/**
 * JSON Schema (draft 2020-12) for one published contract. Input schemas describe what a client sends
 * (`io: "input"`), so defaults are optional there rather than required. Refinements (such as the network origin and
 * cross-field manifest rules) are not expressible in JSON Schema and are only enforced by the Zod contracts.
 */
export function toJsonSchema(name: PublishedSchemaName): Record<string, unknown> {
  const io = INPUT_SCHEMAS.has(name) ? "input" : "output";
  return z.toJSONSchema(PUBLISHED_SCHEMAS[name], { io, unrepresentable: "any" }) as Record<string, unknown>;
}
