import { createRouter } from "../http/router";

/**
 * Package submissions and indexing status.
 *
 * Mounted at `/api/v1` by `createApi`. Endpoints are added here by the delivery that owns npm indexing; until then
 * the router is empty and its paths answer with the standard `not_found` error body.
 */
export function createPublishRouter() {
  return createRouter();
}
