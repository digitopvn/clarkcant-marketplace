import { createRoute, z } from "@hono/zod-openapi";
import { ANONYMOUS_ACTOR, MarketplaceError, requireScope, errorBodySchema, pageKindSchema } from "@marketplace/contracts";
import {
  addBlock,
  assertPreviewSecret,
  createPage,
  describeBlocks,
  ensureDefaultPages,
  getPage,
  getPageRevision,
  listPageRevisions,
  listLayouts,
  listPages,
  pageApiSchemas,
  moveBlock,
  pageRevisionSummarySchema,
  pageSeoPatchSchema,
  pageSummarySchema,
  patchPage,
  previewLinkSchema,
  previewPage,
  publishPage,
  removeBlock,
  renderDocumentForEditor,
  rollbackPage,
  savePageDraft,
  setPageSeo,
  updateBlock,
  type PageState,
} from "@marketplace/marketplace";
import { env } from "cloudflare:workers";
import type { Context } from "hono";

import { createRouter } from "../http/router";
import type { ApiEnv } from "../types";

/*
 * Page administration. Handlers only translate HTTP into the page commands in packages/marketplace, which own
 * validation, scopes (`pages:write`, `pages:publish`), optimistic concurrency, idempotency and audit.
 *
 * Concurrency: every edit names the revision it was based on, either as `If-Match: "<revisionId>"` (the ETag of
 * `GET /admin/pages/{pageId}`) or as `expectedRevisionId` in the body. Retries may send `Idempotency-Key`.
 */

const ERROR_DESCRIPTIONS = {
  400: "Invalid request or document (`validation_failed`)",
  401: "No credential (`unauthorized`)",
  403: "Missing `pages:write` / `pages:publish` scope (`forbidden`)",
  404: "Page, revision or block not found",
  409: "Stale revision or concurrent change (`conflict`, `idempotency_in_progress`)",
  422: "Idempotency-Key reused with a different request (`idempotency_key_reused`)",
  500: "Server error",
} as const;
type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

function errors(...statuses: ErrorStatus[]) {
  return Object.fromEntries(
    statuses.map((status) => [status, { description: ERROR_DESCRIPTIONS[status], content: { "application/json": { schema: errorBodySchema } } }]),
  ) as Record<ErrorStatus, { description: string; content: { "application/json": { schema: typeof errorBodySchema } } }>;
}

const READ_ERRORS = errors(401, 403, 404, 500);
const WRITE_ERRORS = errors(400, 401, 403, 404, 409, 422, 500);

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const idParam = (name: string) =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .openapi({ param: { name, in: "path" } });

const pageParams = z.object({ pageId: idParam("pageId") });
const blockParams = z.object({ pageId: idParam("pageId"), blockId: idParam("blockId") });
const revisionParams = z.object({ pageId: idParam("pageId"), revisionId: idParam("revisionId") });

const writeHeaders = z.object({
  "if-match": z.string().max(80).optional().openapi({ description: "ETag of the revision the edit is based on" }),
  "idempotency-key": z.string().max(255).optional().openapi({ description: "Makes retries safe; replayed for 24 hours" }),
});

const expected = { expectedRevisionId: z.string().min(1).max(64).optional() };
const placement = {
  parentId: z.string().min(1).max(64).nullable().optional(),
  beforeId: z.string().min(1).max(64).optional(),
  afterId: z.string().min(1).max(64).optional(),
};

const routes = {
  describeBlocks: createRoute({
    method: "get",
    path: "/admin/blocks",
    operationId: "listPageBlocks",
    tags: ["pages"],
    summary: "Registered blocks (props JSON Schema, editor fields) and layouts",
    responses: {
      200: json(z.object({ blocks: z.array(z.record(z.string(), z.unknown())), layouts: z.array(z.record(z.string(), z.unknown())) }), "Block and layout registry"),
      ...READ_ERRORS,
    },
  }),
  listPages: createRoute({
    method: "get",
    path: "/admin/pages",
    operationId: "listPages",
    tags: ["pages"],
    responses: { 200: json(z.object({ items: z.array(pageSummarySchema) }), "All pages, including unpublished"), ...READ_ERRORS },
  }),
  createPage: createRoute({
    method: "post",
    path: "/admin/pages",
    operationId: "createPage",
    tags: ["pages"],
    request: {
      headers: writeHeaders,
      body: body(z.object({ slug: z.string(), kind: pageKindSchema, title: z.string().optional(), document: z.unknown().optional() })),
    },
    responses: { 201: json(pageApiSchemas.pageState, "The new page with its first draft revision"), ...WRITE_ERRORS },
  }),
  getPage: createRoute({
    method: "get",
    path: "/admin/pages/{pageId}",
    operationId: "getPage",
    tags: ["pages"],
    request: { params: pageParams },
    responses: { 200: json(pageApiSchemas.pageState, "Draft document and live revision; ETag is the draft revision id"), ...READ_ERRORS },
  }),
  saveDraft: createRoute({
    method: "put",
    path: "/admin/pages/{pageId}/draft",
    operationId: "createPageDraft",
    tags: ["pages"],
    summary: "Save a whole document as the new draft revision",
    request: { params: pageParams, headers: writeHeaders, body: body(z.object({ document: z.unknown(), ...expected })) },
    responses: { 200: json(pageApiSchemas.pageState, "Saved"), ...WRITE_ERRORS },
  }),
  patchPage: createRoute({
    method: "patch",
    path: "/admin/pages/{pageId}",
    operationId: "patchPage",
    tags: ["pages"],
    summary: "Apply a batch of block/SEO operations atomically as one new draft revision",
    request: {
      params: pageParams,
      headers: writeHeaders,
      body: body(z.object({ operations: z.array(pageApiSchemas.operation).min(1).max(100), ...expected })),
    },
    responses: { 200: json(pageApiSchemas.patchResult, "Saved, with the id each operation touched"), ...WRITE_ERRORS },
  }),
  addBlock: createRoute({
    method: "post",
    path: "/admin/pages/{pageId}/blocks",
    operationId: "addBlock",
    tags: ["pages"],
    request: {
      params: pageParams,
      headers: writeHeaders,
      body: body(
        z.object({
          block: z.object({ id: z.string().optional(), type: z.string(), version: z.int().optional(), props: z.record(z.string(), z.unknown()).optional() }),
          ...placement,
          ...expected,
        }),
      ),
    },
    responses: { 200: json(pageApiSchemas.patchResult, "Saved; `results[0].blockId` is the new block"), ...WRITE_ERRORS },
  }),
  updateBlock: createRoute({
    method: "patch",
    path: "/admin/pages/{pageId}/blocks/{blockId}",
    operationId: "updateBlock",
    tags: ["pages"],
    request: {
      params: blockParams,
      headers: writeHeaders,
      body: body(z.object({ props: z.record(z.string(), z.unknown()), mode: z.enum(["merge", "replace"]).optional(), ...expected })),
    },
    responses: { 200: json(pageApiSchemas.patchResult, "Saved"), ...WRITE_ERRORS },
  }),
  removeBlock: createRoute({
    method: "delete",
    path: "/admin/pages/{pageId}/blocks/{blockId}",
    operationId: "removeBlock",
    tags: ["pages"],
    request: { params: blockParams, headers: writeHeaders },
    responses: { 200: json(pageApiSchemas.patchResult, "Saved"), ...WRITE_ERRORS },
  }),
  moveBlock: createRoute({
    method: "post",
    path: "/admin/pages/{pageId}/blocks/{blockId}/move",
    operationId: "moveBlock",
    tags: ["pages"],
    request: { params: blockParams, headers: writeHeaders, body: body(z.object({ ...placement, ...expected })) },
    responses: { 200: json(pageApiSchemas.patchResult, "Saved"), ...WRITE_ERRORS },
  }),
  setSeo: createRoute({
    method: "put",
    path: "/admin/pages/{pageId}/seo",
    operationId: "setPageSeo",
    tags: ["pages"],
    request: { params: pageParams, headers: writeHeaders, body: body(z.object({ seo: pageSeoPatchSchema, ...expected })) },
    responses: { 200: json(pageApiSchemas.patchResult, "Saved"), ...WRITE_ERRORS },
  }),
  preview: createRoute({
    method: "post",
    path: "/admin/pages/{pageId}/preview",
    operationId: "previewPage",
    tags: ["pages"],
    summary: "Create a signed, short-lived preview URL for a revision (the draft by default)",
    request: {
      params: pageParams,
      body: { required: false, content: { "application/json": { schema: z.object({ revisionId: z.string().optional(), ttlSeconds: z.int().optional() }) } } },
    },
    responses: { 200: json(previewLinkSchema.extend({ url: z.string() }), "Preview link"), ...WRITE_ERRORS },
  }),
  publish: createRoute({
    method: "post",
    path: "/admin/pages/{pageId}/publish",
    operationId: "publishPage",
    tags: ["pages"],
    summary: "Publish the current draft revision (requires `pages:publish`)",
    request: { params: pageParams, headers: writeHeaders, body: body(z.object({ revisionId: z.string().optional() })) },
    responses: { 200: json(pageApiSchemas.pageState, "Published"), ...WRITE_ERRORS },
  }),
  rollback: createRoute({
    method: "post",
    path: "/admin/pages/{pageId}/rollback",
    operationId: "rollbackPage",
    tags: ["pages"],
    summary: "Make a previously published revision live again (If-Match: the currently live revision)",
    request: {
      params: pageParams,
      headers: writeHeaders,
      body: body(z.object({ revisionId: z.string(), expectedPublishedRevisionId: z.string().optional() })),
    },
    responses: { 200: json(pageApiSchemas.pageState, "Rolled back"), ...WRITE_ERRORS },
  }),
  listRevisions: createRoute({
    method: "get",
    path: "/admin/pages/{pageId}/revisions",
    operationId: "listPageRevisions",
    tags: ["pages"],
    request: { params: pageParams },
    responses: { 200: json(z.object({ items: z.array(pageRevisionSummarySchema) }), "Newest first"), ...READ_ERRORS },
  }),
  getRevision: createRoute({
    method: "get",
    path: "/admin/pages/{pageId}/revisions/{revisionId}",
    operationId: "getPageRevision",
    tags: ["pages"],
    request: { params: revisionParams },
    responses: { 200: json(pageApiSchemas.revisionDetail, "One immutable revision"), ...READ_ERRORS },
  }),
  defaults: createRoute({
    method: "post",
    path: "/admin/pages/defaults",
    operationId: "ensureDefaultPages",
    tags: ["pages"],
    summary: "Create and publish the default landing (`home`) and `about` pages if missing (requires `pages:publish`)",
    responses: {
      200: json(z.object({ created: z.array(z.string()), existing: z.array(z.string()) }), "Which default pages were created"),
      ...WRITE_ERRORS,
    },
  }),
  render: createRoute({
    method: "post",
    path: "/admin/pages/render",
    operationId: "renderPageDocument",
    tags: ["pages"],
    summary: "Validate and render an unsaved document (builder canvas, Markdown and agent views)",
    request: { body: body(z.object({ document: z.unknown(), slug: z.string().optional() })) },
    responses: { 200: json(pageApiSchemas.renderedDocument, "Rendered with the public renderer"), ...WRITE_ERRORS },
  }),
};

export interface AdminRouterOptions {
  /** Preview-token signing secret. Defaults to the Worker's `BETTER_AUTH_SECRET`, read per request. */
  previewSecret?: () => string | undefined;
}

function workerPreviewSecret(): string | undefined {
  const value = (env as unknown as Record<string, unknown>)["BETTER_AUTH_SECRET"];
  return typeof value === "string" ? value : undefined;
}

/** `If-Match` wins over a body field; both present and different is a client bug worth reporting. */
function expectedRevision(ifMatch: string | undefined, fromBody: string | undefined, field = "expectedRevisionId"): string {
  const header = ifMatch?.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  if (header && fromBody && header !== fromBody) {
    throw new MarketplaceError("validation_failed", `If-Match and ${field} disagree`);
  }
  const value = header || fromBody;
  if (!value) {
    throw new MarketplaceError("validation_failed", `send If-Match or ${field} with the revision this change is based on`, {
      details: [{ path: [field], message: "is required" }],
    });
  }
  return value;
}

function actorOf(c: Context<ApiEnv>) {
  // The actor middleware always sets it; the fallback keeps a host without auth strictly anonymous.
  return c.var.actor ?? ANONYMOUS_ACTOR;
}

function withEtag(c: Context<ApiEnv>, state: PageState) {
  c.header("ETag", `"${state.draft.revision.id}"`);
  c.header("Cache-Control", "private, no-store");
}

export function createAdminRouter(options: AdminRouterOptions = {}) {
  const previewSecret = options.previewSecret ?? workerPreviewSecret;
  return createRouter()
    .openapi(routes.describeBlocks, (c) => {
      // Registry metadata is not secret, but it is only useful to editors; keep it behind the same scope.
      requireScope(actorOf(c), "pages:write");
      return c.json({ blocks: describeBlocks() as unknown as Record<string, unknown>[], layouts: listLayouts() as unknown as Record<string, unknown>[] }, 200);
    })
    .openapi(routes.listPages, async (c) => c.json({ items: await listPages(c.var.context.deps, actorOf(c)) }, 200))
    .openapi(routes.createPage, async (c) => {
      const state = await createPage(c.var.context.deps, actorOf(c), c.req.valid("json"), {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
      });
      withEtag(c, state);
      return c.json(state, 201);
    })
    .openapi(routes.getPage, async (c) => {
      const state = await getPage(c.var.context.deps, actorOf(c), c.req.valid("param").pageId);
      withEtag(c, state);
      return c.json(state, 200);
    })
    .openapi(routes.saveDraft, async (c) => {
      const input = c.req.valid("json");
      const headers = c.req.valid("header");
      const state = await savePageDraft(
        c.var.context.deps,
        actorOf(c),
        {
          pageId: c.req.valid("param").pageId,
          expectedRevisionId: expectedRevision(headers["if-match"], input.expectedRevisionId),
          document: input.document,
        },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, state);
      return c.json(state, 200);
    })
    .openapi(routes.patchPage, async (c) => {
      const input = c.req.valid("json");
      const headers = c.req.valid("header");
      const result = await patchPage(
        c.var.context.deps,
        actorOf(c),
        { pageId: c.req.valid("param").pageId, expectedRevisionId: expectedRevision(headers["if-match"], input.expectedRevisionId), operations: input.operations },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, result);
      return c.json(result, 200);
    })
    .openapi(routes.addBlock, async (c) => {
      const { expectedRevisionId, ...operation } = c.req.valid("json");
      const headers = c.req.valid("header");
      const result = await addBlock(
        c.var.context.deps,
        actorOf(c),
        { ...operation, pageId: c.req.valid("param").pageId, expectedRevisionId: expectedRevision(headers["if-match"], expectedRevisionId) },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, result);
      return c.json(result, 200);
    })
    .openapi(routes.updateBlock, async (c) => {
      const { expectedRevisionId, props, mode } = c.req.valid("json");
      const headers = c.req.valid("header");
      const { pageId, blockId } = c.req.valid("param");
      const result = await updateBlock(
        c.var.context.deps,
        actorOf(c),
        { pageId, blockId, props, mode: mode ?? "merge", expectedRevisionId: expectedRevision(headers["if-match"], expectedRevisionId) },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, result);
      return c.json(result, 200);
    })
    .openapi(routes.removeBlock, async (c) => {
      const headers = c.req.valid("header");
      const { pageId, blockId } = c.req.valid("param");
      const result = await removeBlock(
        c.var.context.deps,
        actorOf(c),
        { pageId, blockId, expectedRevisionId: expectedRevision(headers["if-match"], undefined) },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, result);
      return c.json(result, 200);
    })
    .openapi(routes.moveBlock, async (c) => {
      const { expectedRevisionId, ...target } = c.req.valid("json");
      const headers = c.req.valid("header");
      const { pageId, blockId } = c.req.valid("param");
      const result = await moveBlock(
        c.var.context.deps,
        actorOf(c),
        { ...target, pageId, blockId, expectedRevisionId: expectedRevision(headers["if-match"], expectedRevisionId) },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, result);
      return c.json(result, 200);
    })
    .openapi(routes.setSeo, async (c) => {
      const { expectedRevisionId, seo } = c.req.valid("json");
      const headers = c.req.valid("header");
      const result = await setPageSeo(
        c.var.context.deps,
        actorOf(c),
        { pageId: c.req.valid("param").pageId, seo, expectedRevisionId: expectedRevision(headers["if-match"], expectedRevisionId) },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, result);
      return c.json(result, 200);
    })
    .openapi(routes.preview, async (c) => {
      const input = await readOptionalJson(c);
      const link = await previewPage(
        c.var.context.deps,
        actorOf(c),
        { ...input, pageId: c.req.valid("param").pageId },
        { secret: assertPreviewSecret(previewSecret()) },
      );
      c.header("Cache-Control", "private, no-store");
      // Local development serves on whatever port `astro dev` picked (as auth does), so the link follows the request.
      const { vars } = c.var.context;
      const origin = vars.ENVIRONMENT === "development" ? new URL(c.req.url).origin : vars.PUBLIC_SITE_URL;
      return c.json({ ...link, url: `${origin}${link.path}` }, 200);
    })
    .openapi(routes.publish, async (c) => {
      const input = c.req.valid("json");
      const headers = c.req.valid("header");
      const state = await publishPage(
        c.var.context.deps,
        actorOf(c),
        { pageId: c.req.valid("param").pageId, revisionId: expectedRevision(headers["if-match"], input.revisionId, "revisionId") },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, state);
      return c.json(state, 200);
    })
    .openapi(routes.rollback, async (c) => {
      const input = c.req.valid("json");
      const headers = c.req.valid("header");
      const state = await rollbackPage(
        c.var.context.deps,
        actorOf(c),
        {
          pageId: c.req.valid("param").pageId,
          revisionId: input.revisionId,
          expectedPublishedRevisionId: expectedRevision(headers["if-match"], input.expectedPublishedRevisionId, "expectedPublishedRevisionId"),
        },
        { idempotencyKey: headers["idempotency-key"] },
      );
      withEtag(c, state);
      return c.json(state, 200);
    })
    .openapi(routes.listRevisions, async (c) =>
      c.json({ items: await listPageRevisions(c.var.context.deps, actorOf(c), c.req.valid("param").pageId) }, 200),
    )
    .openapi(routes.getRevision, async (c) => {
      const { pageId, revisionId } = c.req.valid("param");
      return c.json(await getPageRevision(c.var.context.deps, actorOf(c), pageId, revisionId), 200);
    })
    .openapi(routes.defaults, async (c) => c.json(await ensureDefaultPages(c.var.context.deps, actorOf(c)), 200))
    .openapi(routes.render, async (c) => {
      c.header("Cache-Control", "private, no-store");
      return c.json(await renderDocumentForEditor(c.var.context.deps, actorOf(c), c.req.valid("json"), c.var.context.vars.PUBLIC_SITE_URL), 200);
    });
}

/** The preview body is optional; an empty body means "the current draft with the default lifetime". */
async function readOptionalJson(c: Context<ApiEnv>): Promise<{ revisionId?: string; ttlSeconds?: number }> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MarketplaceError("validation_failed", "request body is not valid JSON");
  }
  const result = z.object({ revisionId: z.string().optional(), ttlSeconds: z.int().optional() }).safeParse(parsed);
  if (!result.success) throw new MarketplaceError("validation_failed", "invalid preview request");
  return result.data;
}

