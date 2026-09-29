import { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "../types";
import { validationHook } from "./errors";

/** Every router is created here so all of them share validation behaviour and context typing. */
export function createRouter(): OpenAPIHono<ApiEnv> {
  return new OpenAPIHono<ApiEnv>({ defaultHook: validationHook });
}
