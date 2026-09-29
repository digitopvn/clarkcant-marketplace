import {
  actorHasScope,
  collectionCommandSchema,
  isolationClassSchema,
  MarketplaceError,
  type Actor,
  type ApiScope,
  type RuntimeVars,
} from "@marketplace/contracts";
import {
  assertPreviewSecret,
  featurePackage,
  getPackage,
  getPage,
  listFeaturedPackages,
  listOwnedPackages,
  listPackageVersions,
  listPages,
  manageCollection,
  patchPage,
  previewPage,
  publishPage,
  savePageDraft,
  searchPackages,
  submitPackage,
  uploadMedia,
  type MarketplaceDeps,
} from "@marketplace/marketplace";
import { findSimilarPackages } from "@marketplace/sdk";
import { z } from "zod";

/**
 * The marketplace's MCP tools. Each one calls the same application service the REST API uses, with the caller's
 * resolved `Actor`, so scopes, validation, idempotency and audit behave identically on both surfaces. There is no
 * MCP-only data path.
 *
 * `scope` marks a tool that needs a credential: it is listed only for callers holding that scope, and calling it
 * without one is answered at the HTTP layer with an OAuth challenge (see `mcp-endpoint.ts`).
 */

export interface McpToolContext {
  deps: MarketplaceDeps;
  vars: RuntimeVars;
  /** Site origin serving this request; absolute links in tool results use it. */
  origin: string;
  actor: Actor;
  /** Preview-link signing secret (the Worker's auth secret); `preview_page` fails with `configuration_error` without it. */
  previewSecret?: (() => string | undefined) | undefined;
}

export interface MarketplaceTool<Input extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  scope?: ApiScope;
  inputSchema: Input;
  readOnly: boolean;
  run(context: McpToolContext, input: z.output<Input>): Promise<unknown>;
}

function tool<Input extends z.ZodObject>(definition: MarketplaceTool<Input>): MarketplaceTool {
  return definition as unknown as MarketplaceTool;
}

const packageName = z.string().min(1).max(214).describe("npm package name, e.g. `@acme/clock-widget`");
/** Base64 length of the largest accepted image (5 MiB decoded, the media service's own limit). */
const MAX_UPLOAD_BASE64_LENGTH = Math.ceil((5 * 1024 * 1024) / 3) * 4;

const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Reuse the same key when retrying so the change is applied at most once");
const pageId = z.string().min(1).max(100).describe("Page id (`pg_…`) as returned by get_page");
const revisionId = z.string().min(1).max(100);

export const USER_TOOLS: readonly MarketplaceTool[] = [
  tool({
    name: "search_widgets",
    title: "Search widgets",
    description:
      "Full-text search over indexed ClarkCant packages (widgets, panels, services). Filters combine with AND. " +
      "Returns package summaries and a cursor for the next page.",
    inputSchema: z.object({
      query: z.string().max(200).optional().describe("Words to match in name, description and keywords"),
      category: z.string().max(64).optional().describe("Category slug, e.g. `productivity`"),
      kind: z.string().max(32).optional().describe("Facet kind, e.g. `widget`"),
      isolation: isolationClassSchema.optional(),
      platform: z.string().max(40).optional().describe("Platform the latest version supports, e.g. `macos`"),
      limit: z.int().min(1).max(50).optional(),
      cursor: z.string().max(200).optional(),
    }),
    readOnly: true,
    run: ({ deps }, input) =>
      searchPackages(deps, {
        q: input.query ?? "",
        category: input.category,
        kind: input.kind,
        isolation: input.isolation,
        platform: input.platform,
        limit: input.limit,
        cursor: input.cursor,
      }),
  }),
  tool({
    name: "get_widget",
    title: "Get widget details",
    description: "Full public details of one package: latest version, facets, permissions, previews and security checks.",
    inputSchema: z.object({ name: packageName }),
    readOnly: true,
    run: ({ deps }, input) => getPackage(deps, input.name),
  }),
  tool({
    name: "get_widget_versions",
    title: "List widget versions",
    description: "Indexed versions of a package, newest first.",
    inputSchema: z.object({ name: packageName }),
    readOnly: true,
    run: async ({ deps }, input) => ({ items: await listPackageVersions(deps, input.name) }),
  }),
  tool({
    name: "get_widget_permissions",
    title: "Inspect widget permissions",
    description:
      "Permissions the latest version declares (capabilities, network, filesystem, devices) and its facets. " +
      "Informational: ClarkCant asks the user to grant permissions at install time; nothing here grants them.",
    inputSchema: z.object({ name: packageName }),
    readOnly: true,
    run: async ({ deps }, input) => {
      const detail = await getPackage(deps, input.name);
      if (!detail.latest) throw new MarketplaceError("not_found", `package "${detail.name}" has no indexed version`);
      return {
        package: detail.name,
        version: detail.latest.version,
        permissions: detail.latest.permissions,
        facets: detail.latest.facets,
      };
    },
  }),
  tool({
    name: "find_similar_widgets",
    title: "Find similar widgets",
    description: "Packages sharing keywords, category or facet kind with the given package, best match first, with the reasons.",
    inputSchema: z.object({ name: packageName, limit: z.int().min(1).max(20).optional() }),
    readOnly: true,
    run: async ({ deps }, input) => {
      const source = await getPackage(deps, input.name);
      const items = await findSimilarPackages(source, (query) => searchPackages(deps, query), input.limit ?? 5);
      return { items };
    },
  }),
  tool({
    name: "list_featured_widgets",
    title: "List featured widgets",
    description: "Packages the marketplace curators feature, newest first.",
    inputSchema: z.object({ limit: z.int().min(1).max(50).optional() }),
    readOnly: true,
    run: async ({ deps }, input) => ({ items: await listFeaturedPackages(deps, input.limit ?? 10) }),
  }),
  tool({
    name: "submit_package",
    title: "Submit a package for indexing",
    description:
      "Asks the marketplace to index an npm package version (latest when `version` is omitted). Indexing runs in " +
      "the background; the result is the submission to poll. Requires `packages:submit`.",
    scope: "packages:submit",
    inputSchema: z.object({ name: packageName, version: z.string().max(64).optional(), idempotencyKey }),
    readOnly: false,
    run: ({ deps, actor }, input) =>
      submitPackage(deps, actor, { name: input.name, version: input.version }, { idempotencyKey: input.idempotencyKey }),
  }),
  tool({
    name: "list_my_packages",
    title: "List my packages",
    description: "Packages owned by the signed-in account or its publishers. Requires `account:read`.",
    scope: "account:read",
    inputSchema: z.object({}),
    readOnly: true,
    run: async ({ deps, actor }) => ({ items: await listOwnedPackages(deps, actor) }),
  }),
];

async function resolvePageId(context: McpToolContext, reference: string): Promise<string> {
  const pages = await listPages(context.deps, context.actor);
  const match = pages.find((page) => page.id === reference || page.slug === reference);
  if (!match) throw new MarketplaceError("not_found", `no page with id or slug "${reference}"`);
  return match.id;
}

export const ADMIN_TOOLS: readonly MarketplaceTool[] = [
  tool({
    name: "get_page",
    title: "Get a page",
    description:
      "Draft document, draft revision id and live revision of a marketplace page. Pass the returned " +
      "`draft.revision.id` as `expectedRevisionId` to edits so concurrent changes are detected.",
    scope: "pages:write",
    inputSchema: z.object({ page: z.string().min(1).max(200).describe("Page id (`pg_…`) or slug, e.g. `home`") }),
    readOnly: true,
    run: async (context, input) => getPage(context.deps, context.actor, await resolvePageId(context, input.page)),
  }),
  tool({
    name: "create_page_draft",
    title: "Save a page draft",
    description:
      "Replaces the draft with a whole page document as a new revision. Fails with `conflict` if the draft moved " +
      "past `expectedRevisionId`. Never publishes.",
    scope: "pages:write",
    inputSchema: z.object({
      pageId,
      expectedRevisionId: revisionId,
      document: z.record(z.string(), z.unknown()).describe("A complete PageDocument (schemaVersion, layout, meta, blocks)"),
      idempotencyKey,
    }),
    readOnly: false,
    run: ({ deps, actor }, input) =>
      savePageDraft(
        deps,
        actor,
        { pageId: input.pageId, expectedRevisionId: input.expectedRevisionId, document: input.document },
        { idempotencyKey: input.idempotencyKey },
      ),
  }),
  tool({
    name: "patch_page",
    title: "Edit a page draft",
    description:
      "Applies block, SEO and layout operations (`add_block`, `update_block`, `remove_block`, `move_block`, `set_page_seo`, " +
      "`set_layout`) " +
      "atomically as one new draft revision based on `expectedRevisionId`. Never publishes.",
    scope: "pages:write",
    inputSchema: z.object({
      pageId,
      expectedRevisionId: revisionId,
      operations: z.array(z.record(z.string(), z.unknown())).min(1).max(100).describe("Operations, each with an `op` field"),
      idempotencyKey,
    }),
    readOnly: false,
    run: ({ deps, actor }, input) =>
      patchPage(
        deps,
        actor,
        { pageId: input.pageId, expectedRevisionId: input.expectedRevisionId, operations: input.operations as never },
        { idempotencyKey: input.idempotencyKey },
      ),
  }),
  tool({
    name: "preview_page",
    title: "Preview a page draft",
    description: "A signed, expiring preview URL for a draft revision (the current draft by default).",
    scope: "pages:write",
    inputSchema: z.object({
      pageId,
      revisionId: revisionId.optional(),
      ttlSeconds: z.int().min(60).max(86_400).optional(),
    }),
    readOnly: true,
    run: async ({ deps, actor, origin, previewSecret }, input) => {
      const link = await previewPage(
        deps,
        actor,
        { pageId: input.pageId, revisionId: input.revisionId, ttlSeconds: input.ttlSeconds },
        { secret: assertPreviewSecret(previewSecret?.()) },
      );
      return { ...link, url: new URL(link.path, origin).href };
    },
  }),
  tool({
    name: "publish_page",
    title: "Publish a page",
    description:
      "Makes `revisionId` live. It must be the current draft revision; otherwise the call fails with `conflict` " +
      "and nothing changes. Requires `pages:publish`.",
    scope: "pages:publish",
    inputSchema: z.object({ pageId, revisionId, idempotencyKey }),
    readOnly: false,
    run: ({ deps, actor }, input) =>
      publishPage(deps, actor, { pageId: input.pageId, revisionId: input.revisionId }, { idempotencyKey: input.idempotencyKey }),
  }),
  tool({
    name: "upload_media",
    title: "Upload an image",
    description:
      "Stores an image (PNG, JPEG, WebP or GIF, at most 5 MiB decoded) for use in pages. Returns its " +
      "content-addressed URL. The bytes are sniffed; anything that is not an image is rejected.",
    scope: "media:write",
    inputSchema: z.object({
      base64: z
        .string()
        .min(1)
        .max(MAX_UPLOAD_BASE64_LENGTH)
        .describe("The file's bytes, base64-encoded (no data: prefix), at most 5 MiB decoded"),
      alt: z.string().max(300).optional(),
    }),
    readOnly: false,
    run: ({ deps, actor }, input) => uploadMedia(deps, actor, { base64: input.base64, alt: input.alt }),
  }),
  tool({
    name: "manage_collection",
    title: "Manage a collection",
    description:
      "Creates or edits a curated collection: `create`, `update`, `add_item`, `remove_item` or `reorder`. " +
      "Requires `packages:curate`.",
    scope: "packages:curate",
    inputSchema: z.object({ slug: z.string().min(1).max(64), command: collectionCommandSchema, idempotencyKey }),
    readOnly: false,
    run: ({ deps, actor }, input) => manageCollection(deps, actor, input.slug, input.command, { idempotencyKey: input.idempotencyKey }),
  }),
  tool({
    name: "feature_package",
    title: "Feature or unfeature a package",
    description: "Sets whether a listed package is featured. Hidden or rejected packages cannot be featured. Requires `packages:curate`.",
    scope: "packages:curate",
    inputSchema: z.object({ name: packageName, featured: z.boolean(), idempotencyKey }),
    readOnly: false,
    run: ({ deps, actor }, input) =>
      featurePackage(deps, actor, input.name, { featured: input.featured }, { idempotencyKey: input.idempotencyKey }),
  }),
];

export const MARKETPLACE_TOOLS: readonly MarketplaceTool[] = [...USER_TOOLS, ...ADMIN_TOOLS];

const TOOLS_BY_NAME = new Map(MARKETPLACE_TOOLS.map((entry) => [entry.name, entry]));

export function findMarketplaceTool(name: string): MarketplaceTool | undefined {
  return TOOLS_BY_NAME.get(name);
}

/** Tools the actor may call: unscoped tools for everyone, scoped tools only for holders of their scope. */
export function toolsForActor(actor: Actor): MarketplaceTool[] {
  return MARKETPLACE_TOOLS.filter((entry) => !entry.scope || actorHasScope(actor, entry.scope));
}
