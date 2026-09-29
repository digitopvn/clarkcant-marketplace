import { createApi } from "@marketplace/api";

import { createWebAuthRuntime } from "./auth";
import { createRequestContext } from "./request-context";

/** One Hono app per isolate; it holds no bindings, and each request resolves its own context. */
export const api = createApi({
  resolveContext: createRequestContext,
  resolveAuth: (request, context) => createWebAuthRuntime(request, { context }),
});
