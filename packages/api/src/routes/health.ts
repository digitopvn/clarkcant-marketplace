import { createRoute, z } from "@hono/zod-openapi";
import { checkHealth } from "@marketplace/marketplace";

import { errorResponses } from "../http/errors";
import { createRouter } from "../http/router";

const healthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    environment: z.enum(["development", "staging", "production"]),
    checkedAt: z.iso.datetime(),
    checks: z.object({ database: z.enum(["ok", "error"]) }),
  })
  .openapi("Health");

const getHealth = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  tags: ["system"],
  summary: "Service health, including a live database round-trip",
  responses: {
    200: { description: "Healthy", content: { "application/json": { schema: healthSchema } } },
    503: { description: "A dependency is failing", content: { "application/json": { schema: healthSchema } } },
    ...errorResponses(500),
  },
});

export function createHealthRouter() {
  return createRouter().openapi(getHealth, async (c) => {
    const { deps, vars } = c.var.context;
    const report = await checkHealth(deps);
    c.header("Cache-Control", "no-store");
    const body = { ...report, environment: vars.ENVIRONMENT };
    return report.status === "ok" ? c.json(body, 200) : c.json(body, 503);
  });
}
