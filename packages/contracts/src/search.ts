import { z } from "zod";

import { isolationClassSchema } from "./manifest";
import { categorySlugSchema, packageSummarySchema } from "./packages";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./pagination";

export const MAX_SEARCH_QUERY_LENGTH = 200;

export const searchQuerySchema = z.object({
  /** Free text. Empty means "browse": results fall back to recency ordering. */
  q: z.string().trim().max(MAX_SEARCH_QUERY_LENGTH).default(""),
  category: categorySlugSchema.optional(),
  /** Facet kind filter (e.g. `widget`, `tools`). */
  kind: z.string().min(1).max(32).regex(/^[a-z-]+$/).optional(),
  isolation: isolationClassSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchQueryInput = z.input<typeof searchQuerySchema>;

export const searchResultSchema = z.object({
  query: z.string(),
  items: z.array(packageSummarySchema),
  nextCursor: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
