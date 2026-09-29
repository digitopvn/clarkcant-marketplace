import { MarketplaceError, type Actor } from "@marketplace/contracts";
import { pagePublications, pageRevisions, pages, user } from "@marketplace/db";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MAX_IN_LIST_PARAMETERS,
  chunked,
  createMarketplaceDeps,
  createPage,
  getPage,
  listPageRevisions,
  listPublishedPages,
  publishPage,
  savePageDraft,
  type MarketplaceDeps,
} from "../../src";
import { instrumentD1, type InstrumentOptions } from "../support/instrumented-d1";
import { resetDatabase, testDeps } from "../support/seed";

const admin: Actor = { type: "user", userId: "usr_limits_admin", scopes: ["admin"] };

let deps: MarketplaceDeps;

function instrumentedDeps(options?: InstrumentOptions) {
  const instrumented = instrumentD1(env.DB, options);
  return { deps: { ...createMarketplaceDeps({ d1: instrumented.d1 }), ids: deps.ids }, instrumented };
}

function documentTitled(title: string) {
  return { schemaVersion: 1, layout: { id: "editorial", version: 1 }, meta: { title }, blocks: [] };
}

beforeAll(async () => {
  deps = testDeps();
  await resetDatabase(deps);
  await deps.db.batch([deps.db.delete(pagePublications), deps.db.delete(pageRevisions), deps.db.delete(pages)]);
  await deps.db
    .insert(user)
    .values({ id: "usr_limits_admin", name: "Admin", email: "limits-admin@example.test" })
    .onConflictDoNothing();
});

describe("chunked", () => {
  it("splits id lists into chunks that fit D1's bound-parameter limit", () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id${index}`);
    const chunks = chunked(ids);
    expect(chunks.map((chunk) => chunk.length)).toEqual([90, 90, 70]);
    expect(chunks.flat()).toEqual(ids);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(MAX_IN_LIST_PARAMETERS);
    expect(chunked([])).toEqual([]);
    expect(() => chunked(ids, 0)).toThrow(RangeError);
  });

  it("the test D1 wrapper fails statements binding more than 100 parameters, like production D1", () => {
    const { d1 } = instrumentD1(env.DB);
    const values = Array.from({ length: 101 }, (_, index) => index);
    expect(() => d1.prepare(`select ${values.map(() => "?").join(", ")}`).bind(...values)).toThrow(/at most 100/);
  });
});

describe("draft saves", () => {
  it("rejects a save whose base was superseded between reading the page and writing, instead of losing the other edit", async () => {
    const created = await createPage(deps, admin, { slug: "race", kind: "custom", title: "Race" });
    const base = created.draft.revision.id;
    let competitor: string | null = null;

    // Editor B saves right after editor A has read the page, before A reads anything else.
    const { deps: slowDeps } = instrumentedDeps({
      beforeExecute: async (sql) => {
        if (competitor !== null || !/^select/i.test(sql) || !sql.includes('"page_revisions"')) return;
        competitor = "pending";
        const saved = await savePageDraft(deps, admin, {
          pageId: created.page.id,
          expectedRevisionId: base,
          document: documentTitled("Edit from B"),
        });
        competitor = saved.draft.revision.id;
      },
    });

    const attempt = savePageDraft(slowDeps, admin, {
      pageId: created.page.id,
      expectedRevisionId: base,
      document: documentTitled("Edit from A"),
    });
    await expect(attempt).rejects.toSatisfy((error) => error instanceof MarketplaceError && error.code === "conflict");

    const state = await getPage(deps, admin, created.page.id);
    expect(state.draft.revision.id).toBe(competitor);
    expect(state.draft.revision).toMatchObject({ number: 2, parentRevisionId: base });
    expect(state.draft.document.meta.title).toBe("Edit from B");
    const revisions = await deps.db.select().from(pageRevisions).where(eq(pageRevisions.pageId, created.page.id));
    expect(revisions).toHaveLength(2);
  });
});

describe("D1 bound-parameter limit", () => {
  it("lists the newest 100 revisions of a page with a long history", async () => {
    const created = await createPage(deps, admin, { slug: "long-history", kind: "custom", title: "Long history" });
    const now = new Date("2026-09-29T00:00:00.000Z");
    let parent = created.draft.revision.id;
    const inserts = [];
    for (let number = 2; number <= 130; number += 1) {
      const id = deps.ids("rev");
      inserts.push(
        deps.db.insert(pageRevisions).values({
          id,
          pageId: created.page.id,
          number,
          document: documentTitled(`Long history ${number}`),
          authorId: admin.userId ?? null,
          parentRevisionId: parent,
          createdAt: now,
        }),
      );
      parent = id;
    }
    const [first, ...rest] = inserts;
    if (!first) throw new Error("no revisions to insert");
    await deps.db.batch([first, ...rest]);
    await deps.db.update(pages).set({ currentDraftRevisionId: parent }).where(eq(pages.id, created.page.id));
    await publishPage(deps, admin, { pageId: created.page.id, revisionId: parent });

    const { deps: d1Deps, instrumented } = instrumentedDeps();
    const listed = await listPageRevisions(d1Deps, admin, created.page.id);
    expect(listed).toHaveLength(100);
    expect(listed[0]).toMatchObject({ id: parent, number: 130, isDraft: true, isPublished: true });
    expect(listed[0]?.lastPublishedAt).not.toBeNull();
    // The wrapper saw the queries (so the guard was active) and none bound more than D1 allows.
    expect(instrumented.executed.length).toBeGreaterThan(0);
    expect(instrumented.maxBoundParameters()).toBeGreaterThan(90);
    expect(instrumented.maxBoundParameters()).toBeLessThanOrEqual(100);
  });

  it("lists every published page for the sitemap however many there are", async () => {
    const now = new Date("2026-09-29T00:00:00.000Z");
    const statements = [];
    const slugs: string[] = [];
    for (let index = 0; index < 230; index += 1) {
      const slug = `bulk-${String(index).padStart(3, "0")}`;
      const pageId = deps.ids("page");
      const revisionId = deps.ids("rev");
      slugs.push(slug);
      statements.push(
        deps.db.insert(pages).values({ id: pageId, slug, kind: "custom", title: slug, createdAt: now, updatedAt: now }),
        deps.db.insert(pageRevisions).values({ id: revisionId, pageId, number: 1, document: documentTitled(slug), createdAt: now }),
        deps.db.update(pages).set({ currentDraftRevisionId: revisionId, publishedRevisionId: revisionId }).where(eq(pages.id, pageId)),
        deps.db.insert(pagePublications).values({
          id: deps.ids("pub"),
          pageId,
          revisionId,
          publishedAt: new Date(now.getTime() + index * 1000),
          action: "publish",
        }),
      );
    }
    const [first, ...rest] = statements;
    if (!first) throw new Error("no pages to insert");
    await deps.db.batch([first, ...rest]);

    const { deps: d1Deps, instrumented } = instrumentedDeps();
    const listed = (await listPublishedPages(d1Deps)).filter((page) => page.slug.startsWith("bulk-"));
    expect(listed.map((page) => page.slug)).toEqual(slugs);
    expect(listed[5]).toMatchObject({ path: "/bulk-005", publishedAt: new Date(now.getTime() + 5000).toISOString() });
    expect(instrumented.maxBoundParameters()).toBeLessThanOrEqual(100);

    const page = await listPublishedPages(d1Deps, { afterSlug: "bulk-099", limit: 3 });
    expect(page.map((entry) => entry.slug)).toEqual(["bulk-100", "bulk-101", "bulk-102"]);
  });
});
