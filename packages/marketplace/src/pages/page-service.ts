import {
  MarketplaceError,
  pageSlugSchema,
  requireScope,
  requireUser,
  toAuditActor,
  type Actor,
  type AuditActor,
  type PageDocument,
} from "@marketplace/contracts";
import { pagePublications, pageRevisions, pages } from "@marketplace/db";
import {
  PageOperationError,
  applyPageOperations,
  defaultLayoutForKind,
  parsePageDocument,
  registryBlockDefaults,
  renderPage,
  type PageOperationInput,
  type RenderMode,
} from "@marketplace/page-engine";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { chunked } from "../d1-limits";
import { isConstraintViolation } from "../db-errors";
import { withIdempotency } from "../idempotency/idempotency-store";
import { parseInput } from "../validation";
import { createPageDataPort } from "./page-data-port";
import {
  HOME_PAGE_SLUG,
  createPageInputSchema,
  pageIdSchema,
  patchPageInputSchema,
  previewPageInputSchema,
  publishPageInputSchema,
  renderDocumentInputSchema,
  revisionIdSchema,
  rollbackPageInputSchema,
  savePageDraftInputSchema,
  type CreatePageInput,
  type PageRevisionDetail,
  type PageRevisionSummary,
  type PageState,
  type PageSummary,
  type PatchPageInput,
  type PatchPageResult,
  type PreviewLink,
  type PreviewPageInput,
  type PublishPageInput,
  type PublishedPage,
  type RenderDocumentInput,
  type RenderedDocument,
  type RollbackPageInput,
  type SavePageDraftInput,
} from "./page-schemas";
import { signPreviewToken, verifyPreviewToken } from "./preview-token";

type PageRow = typeof pages.$inferSelect;
type RevisionRow = typeof pageRevisions.$inferSelect;

export interface CommandOptions {
  /** Client-supplied `Idempotency-Key`; a retry with the same key and input replays the first result. */
  idempotencyKey?: string | undefined;
}

const MAX_REVISIONS_LISTED = 100;

/* ------------------------------------------------------------------------------------------------ queries */

/** Every page with its draft/publish pointers, newest edit first. Includes unpublished pages, so it needs write access. */
export async function listPages(deps: MarketplaceDeps, actor: Actor): Promise<PageSummary[]> {
  requireScope(actor, "pages:write");
  const rows = await deps.db.select().from(pages).orderBy(desc(pages.updatedAt), desc(pages.id)).limit(500);
  return rows.map(toPageSummary);
}

/** The editor's view of a page: its current draft document and what is live. */
export async function getPage(deps: MarketplaceDeps, actor: Actor, rawPageId: unknown): Promise<PageState> {
  requireScope(actor, "pages:write");
  return loadPageState(deps, parseInput(pageIdSchema, rawPageId));
}

export async function listPageRevisions(deps: MarketplaceDeps, actor: Actor, rawPageId: unknown): Promise<PageRevisionSummary[]> {
  requireScope(actor, "pages:write");
  const page = await loadPage(deps, parseInput(pageIdSchema, rawPageId));
  const rows = await deps.db
    .select()
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, page.id))
    .orderBy(desc(pageRevisions.number))
    .limit(MAX_REVISIONS_LISTED);
  const publishedAt = await lastPublicationTimes(deps, page.id, rows.map((row) => row.id));
  return rows.map((row) => toRevisionSummary(row, page, publishedAt.get(row.id) ?? null));
}

export async function getPageRevision(
  deps: MarketplaceDeps,
  actor: Actor,
  rawPageId: unknown,
  rawRevisionId: unknown,
): Promise<PageRevisionDetail> {
  requireScope(actor, "pages:write");
  const page = await loadPage(deps, parseInput(pageIdSchema, rawPageId));
  const revision = await loadRevision(deps, page.id, parseInput(revisionIdSchema, rawRevisionId));
  const publishedAt = await lastPublicationTimes(deps, page.id, [revision.id]);
  return { revision: toRevisionSummary(revision, page, publishedAt.get(revision.id) ?? null), document: storedDocument(revision) };
}

/** The live revision of a page. Unpublished pages are indistinguishable from missing ones. */
export async function getPublishedPage(deps: MarketplaceDeps, rawSlug: unknown): Promise<PublishedPage> {
  const slug = parseInput(pageSlugSchema, rawSlug);
  const [row] = await deps.db
    .select({ page: pages, revision: pageRevisions })
    .from(pages)
    .innerJoin(pageRevisions, eq(pageRevisions.id, pages.publishedRevisionId))
    .where(eq(pages.slug, slug))
    .limit(1);
  if (!row) throw new MarketplaceError("not_found", `page "${slug}" was not found`);
  const publishedAt = (await lastPublicationTimes(deps, row.page.id, [row.revision.id])).get(row.revision.id);
  return {
    page: { id: row.page.id, slug: row.page.slug, kind: row.page.kind, title: row.page.title },
    revisionId: row.revision.id,
    revisionNumber: row.revision.number,
    publishedAt: (publishedAt ?? row.page.updatedAt).toISOString(),
    document: storedDocument(row.revision),
  };
}

/* ------------------------------------------------------------------------------------------------ commands */

export async function createPage(
  deps: MarketplaceDeps,
  actor: Actor,
  rawInput: CreatePageInput,
  options: CommandOptions = {},
): Promise<PageState> {
  requireScope(actor, "pages:write");
  const input = parseInput(createPageInputSchema, rawInput);
  return idempotent(deps, actor, "create_page", input, options, () => insertPage(deps, principalOf(actor), input, options));
}

/**
 * Who a command is recorded as: the audit identity, and the account (if any) credited as author or publisher.
 * System commands (e.g. seeding default pages from the jobs Worker) have an audit identity but no account.
 */
export interface CommandPrincipal {
  audit: AuditActor;
  userId: string | null;
}

function principalOf(actor: Actor): CommandPrincipal {
  return { audit: toAuditActor(actor), userId: actor.userId ?? null };
}

/**
 * Creates a page as a system component. For trusted server code only (it performs no scope check); it is not
 * exported from the package's public entry point.
 */
export function createPageAsSystem(deps: MarketplaceDeps, system: AuditActor, rawInput: CreatePageInput): Promise<PageState> {
  return insertPage(deps, { audit: system, userId: null }, parseInput(createPageInputSchema, rawInput));
}

async function insertPage(
  deps: MarketplaceDeps,
  principal: CommandPrincipal,
  input: ReturnType<typeof createPageInputSchema.parse>,
  options: CommandOptions = {},
): Promise<PageState> {
  const document = parsePageDocument(
    input.document ?? {
      schemaVersion: 1,
      layout: defaultLayoutForKind(input.kind),
      meta: { title: input.title ?? titleFromSlug(input.slug) },
      blocks: [],
    },
  );
  const pageId = deps.ids("page");
  const revisionId = deps.ids("rev");
  const now = deps.now();
  const audit = prepareAuditEvent(deps, {
    actor: principal.audit,
    action: "page.created",
    subject: { type: "page", id: pageId },
    idempotencyKey: options.idempotencyKey,
    data: { slug: input.slug, kind: input.kind, revisionId },
  });
  try {
    await deps.db.batch([
      deps.db.insert(pages).values({ id: pageId, slug: input.slug, kind: input.kind, title: document.meta.title, createdAt: now, updatedAt: now }),
      deps.db.insert(pageRevisions).values({
        id: revisionId,
        pageId,
        number: 1,
        document,
        authorId: principal.userId,
        parentRevisionId: null,
        createdAt: now,
      }),
      deps.db.update(pages).set({ currentDraftRevisionId: revisionId }).where(eq(pages.id, pageId)),
      audit.statement,
    ]);
  } catch (error) {
    if (isConstraintViolation(error, "pages.slug")) {
      throw new MarketplaceError("conflict", `a page with slug "${input.slug}" already exists`, { details: { slug: input.slug } });
    }
    throw error;
  }
  return loadPageState(deps, pageId);
}

/** Saves a whole document as the new draft revision (the builder's "Save draft"). */
export async function savePageDraft(
  deps: MarketplaceDeps,
  actor: Actor,
  rawInput: SavePageDraftInput,
  options: CommandOptions = {},
): Promise<PageState> {
  requireScope(actor, "pages:write");
  const input = parseInput(savePageDraftInputSchema, rawInput);
  return idempotent(deps, actor, "save_page_draft", input, options, async () => {
    const page = await loadPage(deps, input.pageId);
    assertCurrentDraft(page, input.expectedRevisionId);
    const base = await loadRevision(deps, page.id, input.expectedRevisionId);
    const document = parsePageDocument(input.document);
    await appendRevision(deps, actor, page, base, document, options, { command: "save_page_draft" });
    return loadPageState(deps, page.id);
  });
}

/**
 * Applies a batch of operations to the current draft and saves the result as one new revision. The batch is
 * all-or-nothing: any failing operation or an invalid resulting document leaves the page untouched.
 */
export async function patchPage(
  deps: MarketplaceDeps,
  actor: Actor,
  rawInput: PatchPageInput,
  options: CommandOptions = {},
): Promise<PatchPageResult> {
  requireScope(actor, "pages:write");
  const input = parseInput(patchPageInputSchema, rawInput);
  return idempotent(deps, actor, "patch_page", input, options, async () => {
    const page = await loadPage(deps, input.pageId);
    assertCurrentDraft(page, input.expectedRevisionId);
    const draft = await loadRevision(deps, page.id, input.expectedRevisionId);
    let applied: ReturnType<typeof applyPageOperations>;
    try {
      applied = applyPageOperations(storedDocument(draft), input.operations, {
        newId: () => deps.ids("blk"),
        blockDefaults: registryBlockDefaults,
      });
    } catch (error) {
      if (error instanceof PageOperationError) {
        throw new MarketplaceError(error.code === "not_found" ? "not_found" : "validation_failed", error.message, {
          details: { operationIndex: error.index },
        });
      }
      throw error;
    }
    const document = parsePageDocument(applied.document);
    await appendRevision(deps, actor, page, draft, document, options, {
      command: "patch_page",
      operations: input.operations.map((operation) => operation.op),
    });
    const state = await loadPageState(deps, page.id);
    return { ...state, results: applied.results };
  });
}

type SingleOperation<T extends PageOperationInput["op"]> = Omit<Extract<PageOperationInput, { op: T }>, "op"> & {
  pageId: string;
  expectedRevisionId: string;
};

/* The single-purpose commands are one-operation patches, so every path shares validation, concurrency and audit. */

export function addBlock(deps: MarketplaceDeps, actor: Actor, input: SingleOperation<"add_block">, options?: CommandOptions) {
  const { pageId, expectedRevisionId, ...operation } = input;
  return patchPage(deps, actor, { pageId, expectedRevisionId, operations: [{ op: "add_block", ...operation }] }, options);
}

export function updateBlock(deps: MarketplaceDeps, actor: Actor, input: SingleOperation<"update_block">, options?: CommandOptions) {
  const { pageId, expectedRevisionId, ...operation } = input;
  return patchPage(deps, actor, { pageId, expectedRevisionId, operations: [{ op: "update_block", ...operation }] }, options);
}

export function removeBlock(deps: MarketplaceDeps, actor: Actor, input: SingleOperation<"remove_block">, options?: CommandOptions) {
  const { pageId, expectedRevisionId, ...operation } = input;
  return patchPage(deps, actor, { pageId, expectedRevisionId, operations: [{ op: "remove_block", ...operation }] }, options);
}

export function moveBlock(deps: MarketplaceDeps, actor: Actor, input: SingleOperation<"move_block">, options?: CommandOptions) {
  const { pageId, expectedRevisionId, ...operation } = input;
  return patchPage(deps, actor, { pageId, expectedRevisionId, operations: [{ op: "move_block", ...operation }] }, options);
}

export function setPageSeo(deps: MarketplaceDeps, actor: Actor, input: SingleOperation<"set_page_seo">, options?: CommandOptions) {
  const { pageId, expectedRevisionId, ...operation } = input;
  return patchPage(deps, actor, { pageId, expectedRevisionId, operations: [{ op: "set_page_seo", ...operation }] }, options);
}

/**
 * Makes the current draft revision live. Requires `pages:publish`, which draft access never implies. The revision
 * must render without unresolved content (missing media, unknown collections…), so nothing silently disappears.
 */
export async function publishPage(
  deps: MarketplaceDeps,
  actor: Actor,
  rawInput: PublishPageInput,
  options: CommandOptions = {},
): Promise<PageState> {
  requireScope(actor, "pages:publish");
  const input = parseInput(publishPageInputSchema, rawInput);
  return idempotent(deps, actor, "publish_page", input, options, () => publishDraft(deps, principalOf(actor), input, options));
}

/** Publishes a page's current draft as a system component. Trusted server code only; see {@link createPageAsSystem}. */
export function publishPageAsSystem(deps: MarketplaceDeps, system: AuditActor, rawInput: PublishPageInput): Promise<PageState> {
  return publishDraft(deps, { audit: system, userId: null }, parseInput(publishPageInputSchema, rawInput));
}

async function publishDraft(
  deps: MarketplaceDeps,
  principal: CommandPrincipal,
  input: ReturnType<typeof publishPageInputSchema.parse>,
  options: CommandOptions = {},
): Promise<PageState> {
  const page = await loadPage(deps, input.pageId);
  if (page.currentDraftRevisionId !== input.revisionId) {
    throw new MarketplaceError("conflict", "only the current draft revision can be published; reload the page", {
      details: { currentRevisionId: page.currentDraftRevisionId },
    });
  }
  if (page.publishedRevisionId === input.revisionId) return loadPageState(deps, page.id);

  const revision = await loadRevision(deps, page.id, input.revisionId);
  const document = parsePageDocument(storedDocument(revision));
  const rendered = await renderPage(document, {
    mode: "preview",
    port: createPageDataPort(deps),
    siteUrl: "",
    path: pagePath(page.slug),
  });
  if (rendered.diagnostics.length > 0) {
    throw new MarketplaceError("validation_failed", "the page has unresolved content; fix it before publishing", {
      details: rendered.diagnostics.map((message) => ({ path: [], message })),
    });
  }
  await movePublishedPointer(deps, principal, page, revision, "publish", options);
  return loadPageState(deps, page.id);
}

/** Restores a previously published revision as the live page (recorded as a `rollback` publication). */
export async function rollbackPage(
  deps: MarketplaceDeps,
  actor: Actor,
  rawInput: RollbackPageInput,
  options: CommandOptions = {},
): Promise<PageState> {
  requireScope(actor, "pages:publish");
  const input = parseInput(rollbackPageInputSchema, rawInput);
  return idempotent(deps, actor, "rollback_page", input, options, async () => {
    const page = await loadPage(deps, input.pageId);
    if (page.publishedRevisionId !== input.expectedPublishedRevisionId) {
      throw new MarketplaceError("conflict", "the live revision changed; reload the page", {
        details: { publishedRevisionId: page.publishedRevisionId },
      });
    }
    if (input.revisionId === page.publishedRevisionId) {
      throw new MarketplaceError("validation_failed", "this revision is already live");
    }
    const revision = await loadRevision(deps, page.id, input.revisionId);
    const [previous] = await deps.db
      .select({ id: pagePublications.id })
      .from(pagePublications)
      .where(and(eq(pagePublications.pageId, page.id), eq(pagePublications.revisionId, revision.id)))
      .limit(1);
    if (!previous) {
      throw new MarketplaceError("validation_failed", "only a revision that was published before can be restored");
    }
    // The stored document must still be renderable by this build; rollback never publishes what cannot render.
    parsePageDocument(storedDocument(revision));
    await movePublishedPointer(deps, principalOf(actor), page, revision, "rollback", options);
    return loadPageState(deps, page.id);
  });
}

export interface PreviewSigning {
  secret: string;
}

/** Issues a signed, expiring link that renders one immutable revision (the draft by default) with noindex. */
export async function previewPage(
  deps: MarketplaceDeps,
  actor: Actor,
  rawInput: PreviewPageInput,
  signing: PreviewSigning,
): Promise<PreviewLink> {
  requireScope(actor, "pages:write");
  const input = parseInput(previewPageInputSchema, rawInput);
  const page = await loadPage(deps, input.pageId);
  const revisionId = input.revisionId ?? page.currentDraftRevisionId;
  if (!revisionId) throw new MarketplaceError("not_found", "this page has no draft to preview");
  const revision = await loadRevision(deps, page.id, revisionId);
  const expiresAt = new Date(deps.now().getTime() + input.ttlSeconds * 1000);
  const token = await signPreviewToken(signing.secret, { pageId: page.id, revisionId: revision.id, expiresAt });
  // The token itself is a bearer credential and is never written to the audit log.
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "page.preview_created",
    subject: { type: "page", id: page.id },
    data: { revisionId: revision.id, expiresAt: expiresAt.toISOString() },
  });
  await audit.statement;
  return { token, path: `/preview/${token}`, revisionId: revision.id, expiresAt: expiresAt.toISOString() };
}

export interface ResolvedPreview {
  page: PageSummary;
  revision: PageRevisionSummary;
  document: PageDocument;
  expiresAt: string;
}

/** Resolves a preview token. Invalid, tampered and expired tokens all yield `not_found`. */
export async function resolvePreview(deps: MarketplaceDeps, token: string, signing: PreviewSigning): Promise<ResolvedPreview> {
  const claims = await verifyPreviewToken(signing.secret, token, deps.now());
  if (!claims) throw new MarketplaceError("not_found", "this preview link is invalid or has expired");
  const page = await loadPage(deps, claims.pageId);
  const revision = await loadRevision(deps, page.id, claims.revisionId);
  const publishedAt = await lastPublicationTimes(deps, page.id, [revision.id]);
  return {
    page: toPageSummary(page),
    revision: toRevisionSummary(revision, page, publishedAt.get(revision.id) ?? null),
    document: storedDocument(revision),
    expiresAt: claims.expiresAt.toISOString(),
  };
}

export interface RenderSettings {
  mode: RenderMode;
  siteUrl: string;
  path: string;
}

/** Renders any valid document through the shared renderer with live marketplace data. */
export function renderPageDocument(deps: MarketplaceDeps, document: PageDocument, settings: RenderSettings) {
  return renderPage(document, { ...settings, port: createPageDataPort(deps) });
}

/** Builder canvas: validates an unsaved document and renders it exactly as the public page would, plus node ids. */
export async function renderDocumentForEditor(
  deps: MarketplaceDeps,
  actor: Actor,
  rawInput: RenderDocumentInput,
  siteUrl: string,
): Promise<RenderedDocument> {
  requireScope(actor, "pages:write");
  const input = parseInput(renderDocumentInputSchema, rawInput);
  const document = parsePageDocument(input.document);
  const rendered = await renderPageDocument(deps, document, {
    mode: "canvas",
    siteUrl,
    path: input.slug ? pagePath(input.slug) : "/",
  });
  return { ...rendered, document };
}

/** Public path of a page; the landing page lives at the site root. */
export function pagePath(slug: string): string {
  return slug === HOME_PAGE_SLUG ? "/" : `/${slug}`;
}

/* ------------------------------------------------------------------------------------------------ internals */

async function idempotent<T>(
  deps: MarketplaceDeps,
  actor: Actor,
  command: string,
  request: unknown,
  options: CommandOptions,
  run: () => Promise<T>,
): Promise<T> {
  if (!options.idempotencyKey) return run();
  const principal = actor.type === "token" && actor.tokenId ? `token:${actor.tokenId}` : `user:${requireUser(actor)}`;
  const outcome = await withIdempotency(
    deps,
    { scope: `${principal}:pages.${command}`, key: options.idempotencyKey },
    request,
    async () => ({ statusCode: 200, response: await run() }),
  );
  return outcome.response;
}

async function loadPage(deps: MarketplaceDeps, pageId: string): Promise<PageRow> {
  const [page] = await deps.db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) throw new MarketplaceError("not_found", `page "${pageId}" was not found`);
  return page;
}

async function loadRevision(deps: MarketplaceDeps, pageId: string, revisionId: string): Promise<RevisionRow> {
  const [revision] = await deps.db
    .select()
    .from(pageRevisions)
    .where(and(eq(pageRevisions.id, revisionId), eq(pageRevisions.pageId, pageId)))
    .limit(1);
  if (!revision) throw new MarketplaceError("not_found", `revision "${revisionId}" does not belong to this page`);
  return revision;
}

async function loadPageState(deps: MarketplaceDeps, pageId: string): Promise<PageState> {
  const page = await loadPage(deps, pageId);
  if (!page.currentDraftRevisionId) {
    throw new MarketplaceError("internal_error", `page "${pageId}" has no draft revision`);
  }
  const ids = [page.currentDraftRevisionId, ...(page.publishedRevisionId ? [page.publishedRevisionId] : [])];
  const revisions = await deps.db.select().from(pageRevisions).where(inArray(pageRevisions.id, ids));
  const publishedAt = await lastPublicationTimes(deps, page.id, ids);
  const draft = revisions.find((row) => row.id === page.currentDraftRevisionId);
  const published = revisions.find((row) => row.id === page.publishedRevisionId);
  if (!draft) throw new MarketplaceError("internal_error", `draft revision of page "${pageId}" is missing`);
  return {
    page: toPageSummary(page),
    draft: { revision: toRevisionSummary(draft, page, publishedAt.get(draft.id) ?? null), document: storedDocument(draft) },
    published: published ? toRevisionSummary(published, page, publishedAt.get(published.id) ?? null) : null,
  };
}

function assertCurrentDraft(page: PageRow, expectedRevisionId: string): void {
  if (page.currentDraftRevisionId !== expectedRevisionId) {
    throw new MarketplaceError("conflict", "the draft was changed by someone else; reload and reapply your edit", {
      details: { currentRevisionId: page.currentDraftRevisionId },
    });
  }
}

/**
 * Appends an immutable revision on top of `base` (the draft the caller edited) and points the draft at it,
 * atomically with its audit event. The new number is always `base.number + 1`: the draft is always the page's newest
 * revision, so any save that landed after `base` was read already holds that number, and the unique
 * `(page_id, number)` index rejects this one as a conflict instead of silently dropping the other edit.
 */
async function appendRevision(
  deps: MarketplaceDeps,
  actor: Actor,
  page: PageRow,
  base: RevisionRow,
  document: PageDocument,
  options: CommandOptions,
  data: Record<string, unknown>,
): Promise<string> {
  const revisionId = deps.ids("rev");
  const number = base.number + 1;
  const now = deps.now();
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "page.draft_saved",
    subject: { type: "page", id: page.id },
    idempotencyKey: options.idempotencyKey,
    data: { ...data, revisionId, number, parentRevisionId: base.id },
  });
  try {
    await deps.db.batch([
      deps.db.insert(pageRevisions).values({
        id: revisionId,
        pageId: page.id,
        number,
        document,
        authorId: actor.userId ?? null,
        parentRevisionId: base.id,
        createdAt: now,
      }),
      deps.db.update(pages).set({ currentDraftRevisionId: revisionId, title: document.meta.title, updatedAt: now }).where(eq(pages.id, page.id)),
      audit.statement,
    ]);
  } catch (error) {
    if (isConstraintViolation(error, "page_revisions.page_id")) {
      throw new MarketplaceError("conflict", "the draft was changed by someone else; reload and reapply your edit");
    }
    throw error;
  }
  return revisionId;
}

/**
 * Points the live page at `revision` and records the publication, atomically. The publication insert carries the
 * precondition: when the page changed since it was read, the insert yields a NULL revision id, the NOT NULL
 * constraint aborts the whole batch, and nothing is written.
 */
async function movePublishedPointer(
  deps: MarketplaceDeps,
  principal: CommandPrincipal,
  page: PageRow,
  revision: RevisionRow,
  action: "publish" | "rollback",
  options: CommandOptions,
): Promise<void> {
  const publicationId = deps.ids("pub");
  const now = deps.now();
  const precondition =
    action === "publish"
      ? sql`${pages.currentDraftRevisionId} = ${revision.id} and ${pages.publishedRevisionId} is ${page.publishedRevisionId}`
      : sql`${pages.publishedRevisionId} is ${page.publishedRevisionId}`;
  const audit = prepareAuditEvent(deps, {
    actor: principal.audit,
    action: action === "publish" ? "page.published" : "page.rolled_back",
    subject: { type: "page", id: page.id },
    idempotencyKey: options.idempotencyKey,
    data: { revisionId: revision.id, number: revision.number, previousRevisionId: page.publishedRevisionId, slug: page.slug },
  });
  try {
    await deps.db.batch([
      deps.db.insert(pagePublications).select(
        deps.db
          .select({
            id: sql`${publicationId}`.as("id"),
            pageId: pages.id,
            revisionId: sql`case when ${precondition} then ${revision.id} else null end`.as("revision_id"),
            publishedBy: sql`${principal.userId}`.as("published_by"),
            publishedAt: sql`${now.getTime()}`.as("published_at"),
            action: sql`${action}`.as("action"),
          })
          .from(pages)
          .where(eq(pages.id, page.id)),
      ),
      deps.db.update(pages).set({ publishedRevisionId: revision.id, updatedAt: now }).where(eq(pages.id, page.id)),
      audit.statement,
    ]);
  } catch (error) {
    if (isConstraintViolation(error, "page_publications.revision_id")) {
      throw new MarketplaceError("conflict", "the page changed while publishing; reload and try again");
    }
    throw error;
  }
}

async function lastPublicationTimes(deps: MarketplaceDeps, pageId: string, revisionIds: string[]): Promise<Map<string, Date>> {
  const rows = [];
  // Chunked so the page id plus the id list stays under D1's bound-parameter limit.
  for (const ids of chunked(revisionIds)) {
    rows.push(
      ...(await deps.db
        .select({ revisionId: pagePublications.revisionId, publishedAt: max(pagePublications.publishedAt) })
        .from(pagePublications)
        .where(and(eq(pagePublications.pageId, pageId), inArray(pagePublications.revisionId, ids)))
        .groupBy(pagePublications.revisionId)),
    );
  }
  const times = new Map<string, Date>();
  for (const row of rows) {
    // `max()` over a timestamp column comes back as the raw integer; normalise it to a Date.
    if (row.publishedAt !== null) times.set(row.revisionId, new Date(row.publishedAt as unknown as number | Date));
  }
  return times;
}

/** Revisions are validated before they are stored, so the stored JSON is a page document. */
function storedDocument(revision: RevisionRow): PageDocument {
  return revision.document as PageDocument;
}

function toPageSummary(row: PageRow): PageSummary {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    currentDraftRevisionId: row.currentDraftRevisionId,
    publishedRevisionId: row.publishedRevisionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRevisionSummary(row: RevisionRow, page: PageRow, lastPublishedAt: Date | null): PageRevisionSummary {
  return {
    id: row.id,
    pageId: row.pageId,
    number: row.number,
    parentRevisionId: row.parentRevisionId,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
    isDraft: row.id === page.currentDraftRevisionId,
    isPublished: row.id === page.publishedRevisionId,
    lastPublishedAt: lastPublishedAt?.toISOString() ?? null,
  };
}

function titleFromSlug(slug: string): string {
  const last = slug.split("/").at(-1) ?? slug;
  return last.replace(/-/g, " ").replace(/^./, (char) => char.toUpperCase());
}
