import { OpenAPIHono } from "@hono/zod-openapi";
import { AUTH_BASE_PATH, createAuthRuntime } from "@marketplace/auth";
import { parseRuntimeVars, type Actor } from "@marketplace/contracts";
import { pagePublications, pageRevisions, pages } from "@marketplace/db";
import { createMarketplaceDeps, resolvePreview } from "@marketplace/marketplace";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src";
import { handleError, validationHook } from "../src/http/errors";
import { createAdminRouter } from "../src/routes/admin";
import type { ApiEnv } from "../src/types";
import { resetDatabase, seedPackage, testDeps } from "../../marketplace/test/support/seed";

const ORIGIN = "http://localhost:4325";
const AUTH_SECRET = `pages-test-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const PREVIEW_SECRET = `preview-test-${crypto.randomUUID()}`;
const ADMIN_EMAIL = `pages-admin-${Date.now().toString(36)}@example.test`;
const vars = parseRuntimeVars({ PUBLIC_SITE_URL: ORIGIN, ENVIRONMENT: "development", ADMIN_EMAILS: ADMIN_EMAIL });
const deps = () => createMarketplaceDeps({ d1: env.DB, media: env.MEDIA });
const authFor = (request: Request) =>
  createAuthRuntime({ deps: deps(), vars, secrets: { BETTER_AUTH_SECRET: AUTH_SECRET }, request });

const api = createApi({ resolveContext: () => ({ deps: deps(), vars }), resolveAuth: (request) => authFor(request) });
const call = (path: string, init: RequestInit = {}) => api.request(`${ORIGIN}/api/v1${path}`, init);

let adminCookie = "";
let editorToken = "";

type Headers = Record<string, string>;
const asAdmin = (extra: Headers = {}): Headers => ({ cookie: adminCookie, origin: ORIGIN, ...extra });
const asEditor = (extra: Headers = {}): Headers => ({ authorization: `Bearer ${editorToken}`, ...extra });
const send = (method: string, path: string, headers: Headers, body?: unknown) =>
  call(path, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const etag = (response: Response) => (response.headers.get("etag") ?? "").replaceAll('"', "");

interface State {
  page: { id: string; publishedRevisionId: string | null };
  draft: { revision: { id: string; number: number }; document: { blocks: { id: string; type: string; props: Record<string, unknown> }[]; meta: { title: string } } };
  published: { revision: { id: string } } | null;
  results?: { blockId?: string }[];
}

beforeAll(async () => {
  const seedDeps = testDeps();
  await resetDatabase(seedDeps);
  await seedDeps.db.batch([seedDeps.db.delete(pagePublications), seedDeps.db.delete(pageRevisions), seedDeps.db.delete(pages)]);
  await seedPackage(seedDeps, {
    name: "@acme/chart-widget",
    displayName: "Chart",
    description: "Charts for dashboards",
    publisher: { slug: "acme", name: "Acme" },
  });

  const signUp = new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: "correct horse battery", name: "Page Admin" }),
  });
  const response = await authFor(signUp).auth.handler(signUp);
  expect(response.status).toBe(200);
  adminCookie =
    response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0] ?? "")
      .find((entry) => entry.startsWith("better-auth.session_token=")) ?? "";
  expect(adminCookie).not.toBe("");

  // An editor credential: may edit pages but not publish them.
  const created = await send("POST", "/me/tokens", asAdmin(), { name: "page-editor", scopes: ["pages:read", "pages:write"] });
  expect(created.status).toBe(201);
  editorToken = ((await created.json()) as { token: string }).token;
});

describe("admin page API", () => {
  it("rejects anonymous callers, read-only scopes and cross-site cookie writes", async () => {
    expect((await send("GET", "/admin/pages", {})).status).toBe(401);
    expect((await send("POST", "/admin/pages", {}, { slug: "x", kind: "custom" })).status).toBe(401);
    const crossSite = await send("POST", "/admin/pages", { cookie: adminCookie, origin: "https://evil.example" }, { slug: "x", kind: "custom" });
    expect(crossSite.status).toBe(403);
    const registry = await send("GET", "/admin/blocks", asEditor());
    expect(registry.status).toBe(200);
    const body = (await registry.json()) as { blocks: { type: string }[]; layouts: unknown[] };
    expect(body.blocks.map((block) => block.type)).toContain("hero");
    expect(body.layouts).toHaveLength(6);
  });

  it("edits with If-Match, publishes with pages:publish, serves JSON and Markdown, and rolls back", async () => {
    expect((await call("/pages/about")).status).toBe(404);

    const created = await send("POST", "/admin/pages", asEditor({ "idempotency-key": "create-about-1" }), {
      slug: "about",
      kind: "custom",
      title: "About the marketplace",
    });
    expect(created.status).toBe(201);
    const state = (await created.json()) as State;
    const pageId = state.page.id;
    expect(etag(created)).toBe(state.draft.revision.id);

    // A retry with the same key replays; it does not create a second page.
    const replay = await send("POST", "/admin/pages", asEditor({ "idempotency-key": "create-about-1" }), {
      slug: "about",
      kind: "custom",
      title: "About the marketplace",
    });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as State).page.id).toBe(pageId);

    // Edits must name their base revision.
    const unconditional = await send("POST", `/admin/pages/${pageId}/blocks`, asEditor(), { block: { type: "rich-text" } });
    expect(unconditional.status).toBe(400);

    const added = await send("POST", `/admin/pages/${pageId}/blocks`, asEditor({ "if-match": `"${etag(created)}"` }), {
      block: { type: "rich-text", props: { markdown: "We **curate** packages." } },
    });
    expect(added.status).toBe(200);
    const addedState = (await added.json()) as State;
    const textId = addedState.results?.[0]?.blockId ?? "";
    expect(addedState.draft.revision.number).toBe(2);

    const stale = await send("PATCH", `/admin/pages/${pageId}/blocks/${textId}`, asEditor({ "if-match": `"${etag(created)}"` }), {
      props: { markdown: "lost update" },
    });
    expect(stale.status).toBe(409);

    const misspelt = await send("PATCH", `/admin/pages/${pageId}`, asEditor({ "if-match": etag(added) }), {
      operations: [{ op: "add_block", block: { type: "hero", props: { heading: "About ClarkCant" } } }],
    });
    expect(misspelt.status).toBe(400);
    expect(JSON.stringify(await misspelt.json())).toContain('unknown property \\"heading\\"');

    const heroAdded = await send("PATCH", `/admin/pages/${pageId}`, asEditor({ "if-match": etag(added) }), {
      operations: [
        { op: "add_block", block: { type: "hero", props: { title: "About ClarkCant" } }, parentId: null, beforeId: textId },
        { op: "set_page_seo", seo: { description: "Who curates the ClarkCant marketplace." } },
      ],
    });
    expect(heroAdded.status).toBe(200);
    const heroState = (await heroAdded.json()) as State;
    expect(heroState.draft.document.blocks.map((block) => block.type)).toEqual(["hero", "rich-text"]);

    const updated = await send("PATCH", `/admin/pages/${pageId}/blocks/${textId}`, asEditor({ "if-match": etag(heroAdded) }), {
      props: { markdown: "We **curate** packages for ClarkCant." },
    });
    expect(updated.status).toBe(200);

    // Editors cannot publish.
    const denied = await send("POST", `/admin/pages/${pageId}/publish`, asEditor({ "if-match": etag(updated) }), {});
    expect(denied.status).toBe(403);

    const published = await send("POST", `/admin/pages/${pageId}/publish`, asAdmin({ "if-match": etag(updated) }), {});
    expect(published.status).toBe(200);
    const firstLive = etag(updated);
    expect(((await published.json()) as State).page.publishedRevisionId).toBe(firstLive);

    const publicJson = await call("/pages/about");
    expect(publicJson.status).toBe(200);
    expect(publicJson.headers.get("etag")).toBe(`"${firstLive}"`);
    expect(await publicJson.json()).toMatchObject({ page: { slug: "about" }, revisionId: firstLive });
    const publicMd = await call("/pages/about?format=md");
    expect(publicMd.headers.get("content-type")).toContain("text/markdown");
    const markdown = await publicMd.text();
    expect(markdown).toContain("# About ClarkCant");
    expect(markdown).toContain("We **curate** packages for ClarkCant.");

    // A second published revision, then roll back to the first.
    const seo = await send("PUT", `/admin/pages/${pageId}/seo`, asEditor({ "if-match": firstLive }), { seo: { title: "About us" } });
    expect(seo.status).toBe(200);
    expect((await send("POST", `/admin/pages/${pageId}/publish`, asAdmin(), { revisionId: etag(seo) })).status).toBe(200);
    expect(((await (await call("/pages/about")).json()) as { revisionId: string }).revisionId).toBe(etag(seo));

    const staleRollback = await send("POST", `/admin/pages/${pageId}/rollback`, asAdmin({ "if-match": firstLive }), { revisionId: firstLive });
    expect(staleRollback.status).toBe(409);
    const rolledBack = await send("POST", `/admin/pages/${pageId}/rollback`, asAdmin({ "if-match": etag(seo) }), { revisionId: firstLive });
    expect(rolledBack.status).toBe(200);
    expect(((await (await call("/pages/about")).json()) as { revisionId: string }).revisionId).toBe(firstLive);

    const revisions = await send("GET", `/admin/pages/${pageId}/revisions`, asEditor());
    const items = ((await revisions.json()) as { items: { id: string; number: number; isPublished: boolean }[] }).items;
    expect(items.map((item) => item.number)).toEqual([5, 4, 3, 2, 1]);
    expect(items.find((item) => item.isPublished)?.id).toBe(firstLive);
    const detail = await send("GET", `/admin/pages/${pageId}/revisions/${firstLive}`, asEditor());
    expect(detail.status).toBe(200);

    // Move and remove round out the block commands.
    const moved = await send("POST", `/admin/pages/${pageId}/blocks/${textId}/move`, asEditor({ "if-match": etag(seo) }), {
      parentId: null,
      beforeId: heroState.draft.document.blocks[0]?.id,
    });
    // A hero may only open the page (the layout's header region), so this move is refused as a whole.
    expect(moved.status).toBe(400);
    expect(JSON.stringify(await moved.json())).toContain("hero cannot appear here");
    const removed = await send("DELETE", `/admin/pages/${pageId}/blocks/${textId}`, asEditor({ "if-match": etag(seo) }));
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as State).draft.document.blocks.map((block) => block.type)).toEqual(["hero"]);
    expect((await send("DELETE", `/admin/pages/${pageId}/blocks/blk_missing`, asEditor({ "if-match": etag(removed) }))).status).toBe(404);
  });

  it("renders unsaved documents for the builder and reports problems as diagnostics", async () => {
    const rendered = await send("POST", "/admin/pages/render", asEditor(), {
      slug: "draft",
      document: {
        schemaVersion: 1,
        layout: { id: "editorial", version: 1 },
        meta: { title: "Draft", description: "", locale: "en", noindex: false },
        blocks: [{ id: "b1", type: "code-install-snippet", version: 1, props: { packageName: "@acme/chart-widget" }, children: [] }],
      },
    });
    expect(rendered.status).toBe(200);
    const body = (await rendered.json()) as { html: string; markdown: string; diagnostics: string[] };
    expect(body.html).toContain("npm install @acme/chart-widget");
    expect(body.diagnostics).toEqual([]);

    const invalid = await send("POST", "/admin/pages/render", asEditor(), { document: { schemaVersion: 1 } });
    expect(invalid.status).toBe(400);
  });

  it("creates the default landing, about, publisher guide and policy pages only for publishers", async () => {
    expect((await send("POST", "/admin/pages/defaults", asEditor())).status).toBe(403);
    const created = await send("POST", "/admin/pages/defaults", asAdmin());
    expect(created.status).toBe(200);
    // "about" was created by an earlier test in this file, so only the landing, publisher guide and policy pages are new.
    expect(await created.json()).toEqual({
      created: ["home", "publish", "terms", "privacy", "cookies", "refunds", "gdpr", "security", "subprocessors"],
      existing: ["about"],
    });
    const home = await call("/pages/home?format=md");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("curated from npm");
  });

  it("does not leak drafts through the public route", async () => {
    const created = await send("POST", "/admin/pages", asEditor(), { slug: "unpublished", kind: "custom" });
    expect(created.status).toBe(201);
    expect((await call("/pages/unpublished")).status).toBe(404);
    expect((await call("/pages/Bad%20Slug")).status).toBe(400);
  });

  it("fails preview with a configuration error when no signing secret is configured", async () => {
    const created = await send("POST", "/admin/pages", asEditor(), { slug: "no-secret", kind: "custom" });
    const { page } = (await created.json()) as State;
    const response = await send("POST", `/admin/pages/${page.id}/preview`, asEditor());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "configuration_error" } });
  });
});

describe("admin preview links", () => {
  // Mounts the router with an explicit secret; the Worker default reads BETTER_AUTH_SECRET, which tests do not bind.
  const editor: Actor = { type: "token", tokenId: "tok_preview", userId: "usr_preview", scopes: ["pages:write"] };
  const harness = new OpenAPIHono<ApiEnv>({ defaultHook: validationHook });
  harness.use("*", async (c, next) => {
    c.set("context", { deps: deps(), vars });
    c.set("actor", editor);
    await next();
  });
  harness.route("/api/v1", createAdminRouter({ previewSecret: () => PREVIEW_SECRET }));
  harness.onError(handleError);

  it("returns a signed, expiring /preview URL that resolves to the draft", async () => {
    const pageId = ((await (await send("POST", "/admin/pages", asEditor(), { slug: "previewed", kind: "custom" })).json()) as State).page.id;
    const response = await harness.request(`${ORIGIN}/api/v1/admin/pages/${pageId}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 120 }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const link = (await response.json()) as { token: string; url: string; expiresAt: string };
    expect(link.url).toBe(`${ORIGIN}/preview/${link.token}`);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);

    const resolved = await resolvePreview(deps(), link.token, { secret: PREVIEW_SECRET });
    expect(resolved.page.id).toBe(pageId);
    await expect(resolvePreview(deps(), link.token, { secret: `${PREVIEW_SECRET}-rotated` })).rejects.toMatchObject({ code: "not_found" });

    const badBody = await harness.request(`${ORIGIN}/api/v1/admin/pages/${pageId}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(badBody.status).toBe(400);
  });
});
