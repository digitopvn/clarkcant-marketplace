import { createRouter } from "../http/router";

/**
 * Page documents: read, draft, preview, publish, rollback.
 *
 * Mounted at `/api/v1` by `createApi`. Endpoints are added here by the delivery that owns the page engine; until
 * then the router is empty and its paths answer with the standard `not_found` error body.
 */
export function createPagesRouter() {
  return createRouter();
}
