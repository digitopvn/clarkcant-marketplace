import { ANONYMOUS_ACTOR, MarketplaceError, type Actor } from "@marketplace/contracts";
import { pagePublications, pageRevisions, pages, user } from "@marketplace/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  addBlock,
  createPage,
  getPage,
  getPublishedPage,
  listAuditEventsForSubject,
  listPageRevisions,
  patchPage,
  previewPage,
  publishPage,
  renderPageDocument,
  resolvePreview,
  rollbackPage,
  savePageDraft,
  setPageSeo,
  type MarketplaceDeps,
} from "../../src";
import { resetDatabase, seedPackage, testDeps } from "../support/seed";

const SECRET = "test-preview-secret-with-at-least-32-chars";
const admin: Actor = { type: "user", userId: "usr_page_admin", scopes: ["admin"] };
const editor: Actor = { type: "user", userId: "usr_page_editor", scopes: ["pages:read", "pages:write"] };
const reader: Actor = { type: "user", userId: "usr_page_reader", scopes: ["pages:read"] };

let deps: MarketplaceDeps;

async function expectError(promise: Promise<unknown>, code: string): Promise<MarketplaceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplaceError);
    expect((error as MarketplaceError).code).toBe(code);
    return error as MarketplaceError;
  }
  throw new Error(`expected ${code}`);
}

beforeAll(async () => {
  deps = testDeps();
  await resetDatabase(deps);
  await deps.db.batch([deps.db.delete(pagePublications), deps.db.delete(pageRevisions), deps.db.delete(pages)]);
  for (const actor of [admin, editor, reader]) {
    await deps.db
      .insert(user)
      .values({ id: actor.userId ?? "", name: actor.userId ?? "", email: `${actor.userId}@example.test` })
      .onConflictDoNothing();
  }
  await seedPackage(deps, {
    name: "@acme/chart-widget",
    displayName: "Chart",
    description: "Charts for dashboards",
    publisher: { slug: "acme", name: "Acme" },
  });
});

describe("page commands", () => {
  it("authorizes by scope: anonymous 401, read-only 403", async () => {
    await expectError(createPage(deps, ANONYMOUS_ACTOR, { slug: "nope", kind: "custom" }), "unauthorized");
    await expectError(createPage(deps, reader, { slug: "nope", kind: "custom" }), "forbidden");
  });

  it("validates slugs and rejects duplicates", async () => {
    await expectError(createPage(deps, admin, { slug: "packages/mine", kind: "custom" }), "validation_failed");
    await expectError(createPage(deps, admin, { slug: "Bad Slug", kind: "custom" }), "validation_failed");
    await createPage(deps, admin, { slug: "dupe", kind: "custom" });
    await expectError(createPage(deps, admin, { slug: "dupe", kind: "custom" }), "conflict");
  });

  it("creates, edits, publishes and rolls back with immutable revisions and audit events", async () => {
    const created = await createPage(deps, editor, { slug: "about", kind: "custom", title: "About us" });
    expect(created.page).toMatchObject({ slug: "about", kind: "custom", title: "About us", publishedRevisionId: null });
    expect(created.draft.revision).toMatchObject({ number: 1, parentRevisionId: null, isDraft: true, isPublished: false });
    expect(created.draft.document.layout).toEqual({ id: "editorial", version: 1 });
    const pageId = created.page.id;

    const withHero = await addBlock(deps, editor, {
      pageId,
      expectedRevisionId: created.draft.revision.id,
      block: { type: "hero", props: { title: "About the marketplace" } },
    });
    const heroId = withHero.results[0]?.blockId ?? "";
    expect(heroId).toMatch(/^blk_/);
    expect(withHero.draft.revision).toMatchObject({ number: 2, parentRevisionId: created.draft.revision.id });

    const patched = await patchPage(deps, editor, {
      pageId,
      expectedRevisionId: withHero.draft.revision.id,
      operations: [
        { op: "add_block", block: { type: "rich-text", props: { markdown: "We **curate** npm packages." } } },
        { op: "add_block", block: { type: "cta", props: { primary: { label: "Browse", href: "/packages" } } }, parentId: heroId },
        { op: "set_page_seo", seo: { description: "Who runs the marketplace" } },
      ],
    });
    expect(patched.draft.revision.number).toBe(3);
    expect(patched.draft.document.blocks.map((block) => block.type)).toEqual(["hero", "rich-text"]);
    expect(patched.draft.document.meta.description).toBe("Who runs the marketplace");

    // Draft access never implies publish access.
    await expectError(publishPage(deps, editor, { pageId, revisionId: patched.draft.revision.id }), "forbidden");
    // Only the current draft can be published.
    await expectError(publishPage(deps, admin, { pageId, revisionId: created.draft.revision.id }), "conflict");

    const first = await publishPage(deps, admin, { pageId, revisionId: patched.draft.revision.id });
    expect(first.published?.id).toBe(patched.draft.revision.id);
    const live = await getPublishedPage(deps, "about");
    expect(live).toMatchObject({ revisionId: patched.draft.revision.id, revisionNumber: 3, page: { slug: "about" } });

    // Re-publishing the live revision is a no-op, not a second publication.
    await publishPage(deps, admin, { pageId, revisionId: patched.draft.revision.id });

    const edited = await setPageSeo(deps, editor, { pageId, expectedRevisionId: patched.draft.revision.id, seo: { title: "About v2" } });
    expect((await getPublishedPage(deps, "about")).document.meta.title).toBe("About us");
    const second = await publishPage(deps, admin, { pageId, revisionId: edited.draft.revision.id });
    expect((await getPublishedPage(deps, "about")).document.meta.title).toBe("About v2");

    await expectError(
      rollbackPage(deps, admin, { pageId, revisionId: created.draft.revision.id, expectedPublishedRevisionId: edited.draft.revision.id }),
      "validation_failed",
    );
    await expectError(
      rollbackPage(deps, admin, { pageId, revisionId: patched.draft.revision.id, expectedPublishedRevisionId: patched.draft.revision.id }),
      "conflict",
    );
    const rolledBack = await rollbackPage(deps, admin, {
      pageId,
      revisionId: patched.draft.revision.id,
      expectedPublishedRevisionId: second.published?.id ?? "",
    });
    expect(rolledBack.published?.id).toBe(patched.draft.revision.id);
    // Rollback moves only the live pointer; the draft keeps the newest edits.
    expect(rolledBack.draft.revision.id).toBe(edited.draft.revision.id);
    expect((await getPublishedPage(deps, "about")).document.meta.title).toBe("About us");

    const publications = await deps.db.select().from(pagePublications).where(eq(pagePublications.pageId, pageId));
    expect(publications.map((row) => row.action).sort()).toEqual(["publish", "publish", "rollback"]);

    const revisions = await listPageRevisions(deps, admin, pageId);
    expect(revisions.map((revision) => revision.number)).toEqual([4, 3, 2, 1]);
    expect(revisions.find((revision) => revision.number === 3)).toMatchObject({ isPublished: true });
    expect(revisions.find((revision) => revision.number === 4)).toMatchObject({ isDraft: true, isPublished: false });

    const audit = await listAuditEventsForSubject(deps, { type: "page", id: pageId });
    expect(audit.map((event) => event.action).sort()).toEqual(
      ["page.created", "page.draft_saved", "page.draft_saved", "page.draft_saved", "page.published", "page.published", "page.rolled_back"].sort(),
    );
    expect(audit.every((event) => event.actor.type === "user")).toBe(true);
  });

  it("rejects invalid documents and stale revisions without writing", async () => {
    const created = await createPage(deps, admin, { slug: "strict", kind: "legal", title: "Terms" });
    const base = { pageId: created.page.id, expectedRevisionId: created.draft.revision.id };

    const invalid = await expectError(
      addBlock(deps, admin, { ...base, block: { type: "hero", props: { title: "" } } }),
      "validation_failed",
    );
    expect(JSON.stringify(invalid.details)).toContain("title");
    // Policy pages cannot hold package showcases.
    await expectError(addBlock(deps, admin, { ...base, block: { type: "package-grid" } }), "validation_failed");
    await expectError(
      savePageDraft(deps, admin, { ...base, document: { schemaVersion: 1, layout: { id: "docs-legal", version: 1 }, meta: { title: "x" }, blocks: [{ id: "a", type: "script", version: 1, props: {} }] } }),
      "validation_failed",
    );
    await expectError(patchPage(deps, admin, { ...base, operations: [{ op: "remove_block", blockId: "missing" }] }), "not_found");

    const saved = await addBlock(deps, admin, { ...base, block: { type: "rich-text", props: { markdown: "Terms." } } });
    const stale = await expectError(addBlock(deps, admin, { ...base, block: { type: "faq" } }), "conflict");
    expect(stale.details).toEqual({ currentRevisionId: saved.draft.revision.id });

    const revisions = await listPageRevisions(deps, admin, created.page.id);
    expect(revisions).toHaveLength(2);
  });

  it("lets exactly one of two concurrent edits from the same base win", async () => {
    const created = await createPage(deps, admin, { slug: "race", kind: "custom" });
    const base = { pageId: created.page.id, expectedRevisionId: created.draft.revision.id };
    const results = await Promise.allSettled([
      addBlock(deps, admin, { ...base, block: { type: "rich-text", props: { markdown: "A" } } }),
      addBlock(deps, admin, { ...base, block: { type: "rich-text", props: { markdown: "B" } } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
    expect(await listPageRevisions(deps, admin, created.page.id)).toHaveLength(2);
  });

  it("records one publication when the same draft is published concurrently", async () => {
    const created = await createPage(deps, admin, { slug: "publish-race", kind: "custom" });
    const input = { pageId: created.page.id, revisionId: created.draft.revision.id };
    const results = await Promise.allSettled([publishPage(deps, admin, input), publishPage(deps, admin, input), publishPage(deps, admin, input)]);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "conflict" });
    }
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const publications = await deps.db.select().from(pagePublications).where(eq(pagePublications.pageId, created.page.id));
    expect(publications).toHaveLength(1);
    const audit = await listAuditEventsForSubject(deps, { type: "page", id: created.page.id });
    expect(audit.filter((event) => event.action === "page.published")).toHaveLength(1);
  });

  it("replays idempotent retries and rejects a reused key with a different request", async () => {
    const options = { idempotencyKey: "create-page-key-0001" };
    const first = await createPage(deps, admin, { slug: "idem", kind: "custom" }, options);
    const retry = await createPage(deps, admin, { slug: "idem", kind: "custom" }, options);
    expect(retry.page.id).toBe(first.page.id);
    await expectError(createPage(deps, admin, { slug: "idem-other", kind: "custom" }, options), "idempotency_key_reused");

    const patchOptions = { idempotencyKey: "patch-page-key-0001" };
    const input = { pageId: first.page.id, expectedRevisionId: first.draft.revision.id, operations: [{ op: "add_block" as const, block: { type: "faq" } }] };
    const patched = await patchPage(deps, admin, input, patchOptions);
    const replayed = await patchPage(deps, admin, input, patchOptions);
    expect(replayed.draft.revision.id).toBe(patched.draft.revision.id);
    expect(await listPageRevisions(deps, admin, first.page.id)).toHaveLength(2);

    const audit = await listAuditEventsForSubject(deps, { type: "page", id: first.page.id });
    expect(audit.find((event) => event.action === "page.created")?.idempotencyKey).toBe("create-page-key-0001");
  });

  it("refuses to publish unresolved content", async () => {
    const created = await createPage(deps, admin, { slug: "gallery", kind: "custom" });
    const withMedia = await addBlock(deps, admin, {
      pageId: created.page.id,
      expectedRevisionId: created.draft.revision.id,
      block: { type: "media", props: { mediaId: "med_missing", alt: "Screenshot" } },
    });
    const error = await expectError(publishPage(deps, admin, { pageId: created.page.id, revisionId: withMedia.draft.revision.id }), "validation_failed");
    expect(JSON.stringify(error.details)).toContain("med_missing");
    await expectError(getPublishedPage(deps, "gallery"), "not_found");
  });
});

describe("previews and rendering", () => {
  it("issues signed previews bound to one revision and rejects tampered or expired tokens", async () => {
    const created = await createPage(deps, admin, { slug: "preview-me", kind: "custom", title: "Draft page" });
    await expectError(previewPage(deps, reader, { pageId: created.page.id }, { secret: SECRET }), "forbidden");
    const link = await previewPage(deps, editor, { pageId: created.page.id, ttlSeconds: 120 }, { secret: SECRET });
    expect(link.path).toBe(`/preview/${link.token}`);
    expect(link.revisionId).toBe(created.draft.revision.id);

    const resolved = await resolvePreview(deps, link.token, { secret: SECRET });
    expect(resolved.document.meta.title).toBe("Draft page");
    expect(resolved.revision.id).toBe(created.draft.revision.id);

    const [payload, signature] = link.token.split(".");
    const forged = `${payload?.slice(0, -2)}xx.${signature}`;
    await expectError(resolvePreview(deps, forged, { secret: SECRET }), "not_found");
    await expectError(resolvePreview(deps, link.token, { secret: `${SECRET}-rotated` }), "not_found");
    const later = { ...deps, now: () => new Date(Date.now() + 121_000) };
    await expectError(resolvePreview(later, link.token, { secret: SECRET }), "not_found");

    const audit = await listAuditEventsForSubject(deps, { type: "page", id: created.page.id });
    const previewEvent = audit.find((event) => event.action === "page.preview_created");
    expect(previewEvent).toBeDefined();
    expect(JSON.stringify(previewEvent)).not.toContain(link.token);
  });

  it("renders bound blocks from live marketplace data", async () => {
    const state = await createPage(deps, admin, {
      slug: "landing-test",
      kind: "landing",
      document: {
        schemaVersion: 1,
        layout: { id: "marketplace-landing", version: 1 },
        meta: { title: "Home" },
        blocks: [
          { id: "hero", type: "hero", version: 1, props: { title: "Widgets for ClarkCant" } },
          { id: "grid", type: "package-grid", version: 1, props: { title: "Latest" } },
          { id: "stats", type: "stats", version: 1, props: { items: [{ label: "Listed", metric: "packages" }] } },
          { id: "snippet", type: "code-install-snippet", version: 1, props: { packageName: "@acme/chart-widget" } },
          { id: "publisher", type: "publisher-profile", version: 1, props: { publisherSlug: "acme" } },
        ],
      },
    });
    const rendered = await renderPageDocument(deps, state.draft.document, { mode: "public", siteUrl: "https://market.example", path: "/" });
    expect(rendered.diagnostics).toEqual([]);
    expect(rendered.html).toContain('href="/packages/%40acme/chart-widget"');
    expect(rendered.html).toContain('<dd class="pe-stat-value">1</dd>');
    expect(rendered.html).toContain("npm install @acme/chart-widget@1.0.0");
    expect(rendered.html).toContain("Acme");
    expect(rendered.markdown).toContain("# Widgets for ClarkCant");
    expect(rendered.structuredData.map((entry) => entry["@type"])).toContain("ItemList");

    const loaded = await getPage(deps, admin, state.page.id);
    expect(loaded.draft.document.blocks).toHaveLength(5);
  });
});
