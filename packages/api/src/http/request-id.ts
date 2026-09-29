import { createMiddleware } from "hono/factory";

import type { ApiEnv } from "../types";

export const REQUEST_ID_HEADER = "X-Request-Id";
const ACCEPTABLE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Propagates a caller-supplied request id when it is well-formed (so traces join up across services) and mints one
 * otherwise. The id is echoed on every response and in every error body.
 */
export const requestId = createMiddleware<ApiEnv>(async (c, next) => {
  const incoming = c.req.header(REQUEST_ID_HEADER);
  const id = incoming && ACCEPTABLE_ID.test(incoming) ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  c.header(REQUEST_ID_HEADER, id);
  await next();
});
