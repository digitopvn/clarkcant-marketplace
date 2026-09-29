import { z } from "zod";

/**
 * The versioned page AST. A page is data, never code: blocks are referenced by `type` + `version` and rendered by
 * the page engine's registry, which validates each block's `props` against that block's own schema. This contract
 * fixes only the envelope so every interface (builder, API, MCP, renderers) agrees on it.
 */
export const PAGE_DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_BLOCK_DEPTH = 8;
export const MAX_BLOCKS_PER_LIST = 200;

export const pageKindSchema = z.enum(["custom", "legal", "docs", "landing", "category", "collection"]);
export type PageKind = z.infer<typeof pageKindSchema>;

export const pageSlugSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/, { error: "must be a lowercase path slug" });

export const blockTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/, { error: "must be a lowercase block type such as hero" });

export interface BlockNode {
  id: string;
  type: string;
  version: number;
  props: Record<string, unknown>;
  children?: BlockNode[] | undefined;
}

export const blockNodeSchema: z.ZodType<BlockNode> = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  type: blockTypeSchema,
  version: z.int().positive(),
  props: z.record(z.string(), z.unknown()),
  get children() {
    return z.array(blockNodeSchema).max(MAX_BLOCKS_PER_LIST).optional();
  },
});

/** Id of an uploaded media object (`media.id`); page documents reference media by id, never by URL. */
export const mediaIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, { error: "must be a media id" });

export const pageDocumentSchema = z
  .object({
    schemaVersion: z.literal(PAGE_DOCUMENT_SCHEMA_VERSION),
    layout: z.object({ id: z.string().min(1).max(64), version: z.int().positive() }),
    meta: z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(500).default(""),
      locale: z.string().min(2).max(35).default("en"),
      noindex: z.boolean().default(false),
      /** Share image (Open Graph/Twitter card) as a raster media id. Optional: the site default card applies. */
      image: mediaIdSchema.optional(),
    }),
    blocks: z.array(blockNodeSchema).max(MAX_BLOCKS_PER_LIST),
  })
  .superRefine((document, ctx) => {
    const seen = new Set<string>();
    const walk = (nodes: readonly BlockNode[], depth: number): void => {
      if (depth > MAX_BLOCK_DEPTH) {
        ctx.addIssue({ code: "custom", message: `blocks nest deeper than ${MAX_BLOCK_DEPTH} levels` });
        return;
      }
      for (const node of nodes) {
        if (seen.has(node.id)) ctx.addIssue({ code: "custom", message: `duplicate block id "${node.id}"` });
        seen.add(node.id);
        if (node.children) walk(node.children, depth + 1);
      }
    };
    walk(document.blocks, 1);
  });
export type PageDocument = z.infer<typeof pageDocumentSchema>;
export type PageDocumentInput = z.input<typeof pageDocumentSchema>;
