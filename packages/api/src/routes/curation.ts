import { createRoute, z } from "@hono/zod-openapi";
import {
  ANONYMOUS_ACTOR,
  collectionCommandSchema,
  collectionStateSchema,
  curationStateSchema,
  errorBodySchema,
  featurePackageInputSchema,
  setCurationStatusInputSchema,
  slugSchema,
} from "@marketplace/contracts";
import { featurePackage, getCollectionState, manageCollection, setCurationStatus } from "@marketplace/marketplace";

import { createRouter } from "../http/router";

/*
 * Curation commands (`packages:curate`): `set_curation_status`, `feature_package` and `manage_collection`. Each
 * writes its change and an audit event atomically and accepts `Idempotency-Key`. Curation is editorial only: it
 * never changes a package's integrity or security facts. Mounted through the catalog router.
 */

const ERROR_DESCRIPTIONS = {
  400: "Invalid request (`validation_failed`)",
  401: "No credential (`unauthorized`)",
  403: "Missing `packages:curate` scope or cross-site request (`forbidden`)",
  404: "Package or collection not found",
  409: "Conflicts with the current state (`conflict`, `idempotency_in_progress`)",
  422: "Idempotency-Key reused with a different request (`idempotency_key_reused`)",
  500: "Server error",
} as const;
type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

function errors(...statuses: ErrorStatus[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      { description: ERROR_DESCRIPTIONS[status], content: { "application/json": { schema: errorBodySchema } } },
    ]),
  ) as Record<ErrorStatus, { description: string; content: { "application/json": { schema: typeof errorBodySchema } } }>;
}

const WRITE_ERRORS = errors(400, 401, 403, 404, 409, 422, 500);
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const writeHeaders = z.object({
  "idempotency-key": z
    .string()
    .min(1)
    .max(255)
    .optional()
    .openapi({ description: "Makes retries safe; replayed for 24 hours" }),
});
const nameParams = z.object({
  name: z
    .string()
    .min(1)
    .max(214)
    .openapi({ param: { name: "name", in: "path" }, example: "%40acme%2Fchart-widget" }),
});
const slugParams = z.object({ slug: slugSchema });

const setStatusRoute = createRoute({
  method: "post",
  path: "/curation/packages/{name}/status",
  operationId: "setCurationStatus",
  tags: ["curation"],
  summary: "Set a package's curation status (unreviewed, listed, featured, hidden, rejected)",
  request: { params: nameParams, headers: writeHeaders, body: body(setCurationStatusInputSchema) },
  responses: { 200: json(curationStateSchema, "Resulting curation state"), ...WRITE_ERRORS },
});

const featureRoute = createRoute({
  method: "post",
  path: "/curation/packages/{name}/featured",
  operationId: "featurePackage",
  tags: ["curation"],
  summary: "Feature a package, or return a featured package to plain listing",
  request: { params: nameParams, headers: writeHeaders, body: body(featurePackageInputSchema) },
  responses: { 200: json(curationStateSchema, "Resulting curation state"), ...WRITE_ERRORS },
});

const getCollectionStateRoute = createRoute({
  method: "get",
  path: "/curation/collections/{slug}",
  operationId: "getCollectionState",
  tags: ["curation"],
  summary: "Admin view of a collection, including unpublished state and non-public items",
  request: { params: slugParams },
  responses: { 200: json(collectionStateSchema, "Collection state"), ...errors(400, 401, 403, 404, 500) },
});

const manageCollectionRoute = createRoute({
  method: "post",
  path: "/curation/collections/{slug}",
  operationId: "manageCollection",
  tags: ["curation"],
  summary: "Run one collection command: create, update, add_item, remove_item or reorder",
  request: { params: slugParams, headers: writeHeaders, body: body(collectionCommandSchema) },
  responses: { 200: json(collectionStateSchema, "Resulting collection state"), ...WRITE_ERRORS },
});

const optionsFrom = (key: string | undefined) => (key ? { idempotencyKey: key } : {});

export function createCurationRouter() {
  return createRouter()
    .openapi(setStatusRoute, async (c) => {
      const state = await setCurationStatus(
        c.var.context.deps,
        c.var.actor ?? ANONYMOUS_ACTOR,
        c.req.valid("param").name,
        c.req.valid("json"),
        optionsFrom(c.req.valid("header")["idempotency-key"]),
      );
      return c.json(state, 200);
    })
    .openapi(featureRoute, async (c) => {
      const state = await featurePackage(
        c.var.context.deps,
        c.var.actor ?? ANONYMOUS_ACTOR,
        c.req.valid("param").name,
        c.req.valid("json"),
        optionsFrom(c.req.valid("header")["idempotency-key"]),
      );
      return c.json(state, 200);
    })
    .openapi(getCollectionStateRoute, async (c) => {
      c.header("Cache-Control", "private, no-store");
      const state = await getCollectionState(c.var.context.deps, c.var.actor ?? ANONYMOUS_ACTOR, c.req.valid("param").slug);
      return c.json(state, 200);
    })
    .openapi(manageCollectionRoute, async (c) => {
      const state = await manageCollection(
        c.var.context.deps,
        c.var.actor ?? ANONYMOUS_ACTOR,
        c.req.valid("param").slug,
        c.req.valid("json"),
        optionsFrom(c.req.valid("header")["idempotency-key"]),
      );
      return c.json(state, 200);
    });
}
