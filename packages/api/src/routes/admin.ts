import { createRouter } from "../http/router";

/**
 * Curation and content administration.
 *
 * Mounted at `/api/v1` by `createApi`. Endpoints are added here by the deliveries that own curation and page
 * administration; until then the router is empty and its paths answer with the standard `not_found` error body.
 */
export function createAdminRouter() {
  return createRouter();
}
