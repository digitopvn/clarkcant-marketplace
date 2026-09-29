import { createRouter } from "../http/router";

/**
 * The signed-in account: profile, API tokens, device links, data export and deletion.
 *
 * Mounted at `/api/v1` by `createApi`. Endpoints are added here by the delivery that owns auth and accounts; until
 * then the router is empty and its paths answer with the standard `not_found` error body.
 */
export function createMeRouter() {
  return createRouter();
}
