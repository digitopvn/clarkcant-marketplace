import { z } from "zod";

import { MAX_PACKAGE_QUERY_LENGTH, packageFilterShape, packageSummarySchema } from "./packages";

export const MAX_SEARCH_QUERY_LENGTH = MAX_PACKAGE_QUERY_LENGTH;

/** Free text (`q`) plus the shared package filters. An empty `q` browses: results fall back to recency ordering. */
export const searchQuerySchema = z.object(packageFilterShape);
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchQueryInput = z.input<typeof searchQuerySchema>;

export const searchResultSchema = z.object({
  query: z.string(),
  items: z.array(packageSummarySchema),
  nextCursor: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
