import { pageDocumentSchema, pageKindSchema, pageSlugSchema } from "@marketplace/contracts";
import { pageOperationsSchema, pageSeoPatchSchema } from "@marketplace/page-engine";
import {
  addBlockOpSchema,
  moveBlockOpSchema,
  removeBlockOpSchema,
  setLayoutOpSchema,
  setPageSeoOpSchema,
  updateBlockOpSchema,
} from "@marketplace/page-engine/operations";
import { z } from "zod";

/*
 * Inputs and outputs of the page commands. They are shared by every interface (REST, MCP, CLI, builder), so they
 * live next to the services rather than in one transport.
 */

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const pageIdSchema = id;
export const revisionIdSchema = id;

/** Top-level paths owned by application routes; a page slug may not shadow them. */
export const RESERVED_PAGE_SLUGS = [
  "admin",
  "api",
  "preview",
  "packages",
  "categories",
  "collections",
  "media",
  "login",
  "signup",
  "account",
  "device",
  "oauth",
  "mcp",
  "openapi.json",
  "index",
  "robots.txt",
  "sitemap.xml",
  "llms.txt",
  "llms-full.txt",
  "docs/api",
] as const;

/** Slug of the landing page that the site root `/` renders when it is published. */
export const HOME_PAGE_SLUG = "home";

export const publicPageSlugSchema = pageSlugSchema.refine(
  (slug) => !RESERVED_PAGE_SLUGS.some((reserved) => slug === reserved || slug.startsWith(`${reserved}/`)),
  { error: "this path is used by the application; choose another slug" },
);

export const createPageInputSchema = z.object({
  slug: publicPageSlugSchema,
  kind: pageKindSchema,
  /** Used for the initial document when `document` is absent. */
  title: z.string().trim().min(1).max(200).optional(),
  /** Full initial document; otherwise an empty document with the kind's default layout. */
  document: z.unknown().optional(),
});
export type CreatePageInput = z.input<typeof createPageInputSchema>;

export const savePageDraftInputSchema = z.object({
  pageId: pageIdSchema,
  expectedRevisionId: revisionIdSchema,
  document: z.unknown(),
});
export type SavePageDraftInput = z.input<typeof savePageDraftInputSchema>;

export const patchPageInputSchema = z.object({
  pageId: pageIdSchema,
  expectedRevisionId: revisionIdSchema,
  operations: pageOperationsSchema,
});
export type PatchPageInput = z.input<typeof patchPageInputSchema>;

export const publishPageInputSchema = z.object({
  pageId: pageIdSchema,
  /** Must be the current draft revision: you publish exactly what you reviewed. */
  revisionId: revisionIdSchema,
});
export type PublishPageInput = z.input<typeof publishPageInputSchema>;

export const rollbackPageInputSchema = z.object({
  pageId: pageIdSchema,
  /** A revision of this page that was published before. */
  revisionId: revisionIdSchema,
  /** The revision currently live; the rollback fails if someone published in the meantime. */
  expectedPublishedRevisionId: revisionIdSchema,
});
export type RollbackPageInput = z.input<typeof rollbackPageInputSchema>;

export const PREVIEW_TTL_DEFAULT_SECONDS = 30 * 60;
export const PREVIEW_TTL_MAX_SECONDS = 24 * 60 * 60;

export const previewPageInputSchema = z.object({
  pageId: pageIdSchema,
  /** Defaults to the current draft. */
  revisionId: revisionIdSchema.optional(),
  ttlSeconds: z.int().min(60).max(PREVIEW_TTL_MAX_SECONDS).default(PREVIEW_TTL_DEFAULT_SECONDS),
});
export type PreviewPageInput = z.input<typeof previewPageInputSchema>;

export const renderDocumentInputSchema = z.object({
  document: z.unknown(),
  /** Page path used for canonical URLs in structured data. */
  slug: pageSlugSchema.optional(),
});
export type RenderDocumentInput = z.input<typeof renderDocumentInputSchema>;

export { pageSeoPatchSchema };

const isoDateTime = z.iso.datetime();

export const pageSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  kind: pageKindSchema,
  title: z.string(),
  currentDraftRevisionId: z.string().nullable(),
  publishedRevisionId: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type PageSummary = z.infer<typeof pageSummarySchema>;

export const pageRevisionSummarySchema = z.object({
  id: z.string(),
  pageId: z.string(),
  number: z.int(),
  parentRevisionId: z.string().nullable(),
  authorId: z.string().nullable(),
  createdAt: isoDateTime,
  isDraft: z.boolean(),
  isPublished: z.boolean(),
  /** When this revision was last made live (publish or rollback), if ever. */
  lastPublishedAt: isoDateTime.nullable(),
});
export type PageRevisionSummary = z.infer<typeof pageRevisionSummarySchema>;

export const pageStateSchema = z.object({
  page: pageSummarySchema,
  draft: z.object({ revision: pageRevisionSummarySchema, document: pageDocumentSchema }),
  published: pageRevisionSummarySchema.nullable(),
});
export type PageState = z.infer<typeof pageStateSchema>;

export const pageRevisionDetailSchema = z.object({ revision: pageRevisionSummarySchema, document: pageDocumentSchema });
export type PageRevisionDetail = z.infer<typeof pageRevisionDetailSchema>;

export const publishedPageSchema = z.object({
  page: z.object({ id: z.string(), slug: z.string(), kind: pageKindSchema, title: z.string() }),
  revisionId: z.string(),
  revisionNumber: z.int(),
  publishedAt: isoDateTime,
  document: pageDocumentSchema,
});
export type PublishedPage = z.infer<typeof publishedPageSchema>;

export const patchPageResultSchema = pageStateSchema.extend({
  results: z.array(z.object({ op: z.string(), blockId: z.string().optional() })),
});
export type PatchPageResult = z.infer<typeof patchPageResultSchema>;

export const previewLinkSchema = z.object({
  token: z.string(),
  /** Site-relative URL of the preview page. */
  path: z.string(),
  revisionId: z.string(),
  expiresAt: isoDateTime,
});
export type PreviewLink = z.infer<typeof previewLinkSchema>;

export const renderedDocumentSchema = z.object({
  html: z.string(),
  markdown: z.string(),
  structuredData: z.array(z.record(z.string(), z.unknown())),
  summary: z.string(),
  diagnostics: z.array(z.string()),
  document: pageDocumentSchema,
});
export type RenderedDocument = z.infer<typeof renderedDocumentSchema>;

/*
 * OpenAPI stand-ins. OpenAPI generators cannot follow the recursive block schema (`children` refers back to the
 * block), so transports document and pre-validate page documents with this one-level shape; the page services
 * still validate every document and operation strictly. Nested `children` items have the same shape as a block.
 */
const blockNodeApiSchema = z.object({
  id: z.string(),
  type: z.string(),
  version: z.int(),
  props: z.record(z.string(), z.unknown()),
  children: z.array(z.record(z.string(), z.unknown())).optional().describe("Nested blocks, each shaped like this block"),
});

export const pageDocumentApiSchema = z.object({
  schemaVersion: z.literal(1),
  layout: z.object({ id: z.string(), version: z.int() }),
  meta: z.object({ title: z.string(), description: z.string(), locale: z.string(), noindex: z.boolean() }),
  blocks: z.array(blockNodeApiSchema),
});

const pageStateApiSchema = pageStateSchema.extend({
  draft: z.object({ revision: pageRevisionSummarySchema, document: pageDocumentApiSchema }),
});

export const pageApiSchemas = {
  pageState: pageStateApiSchema,
  patchResult: pageStateApiSchema.extend({ results: patchPageResultSchema.shape.results }),
  revisionDetail: pageRevisionDetailSchema.extend({ document: pageDocumentApiSchema }),
  publishedPage: publishedPageSchema.extend({ document: pageDocumentApiSchema }),
  renderedDocument: renderedDocumentSchema.extend({ document: pageDocumentApiSchema }),
  operation: z.discriminatedUnion("op", [
    addBlockOpSchema.extend({ block: addBlockOpSchema.shape.block.extend({ children: z.array(blockNodeApiSchema).max(12).optional() }) }),
    updateBlockOpSchema,
    removeBlockOpSchema,
    moveBlockOpSchema,
    setPageSeoOpSchema,
    setLayoutOpSchema,
  ]),
};
