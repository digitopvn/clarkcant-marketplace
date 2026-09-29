import type { Actor } from "@marketplace/contracts";
import { pagePublications, pageRevisions, pages, user } from "@marketplace/db";
import {
  MAX_PUBLISHED_PAGES_LISTED,
  createPage,
  publishPage,
  setPageSeo,
  type MarketplaceDeps,
} from "@marketplace/marketplace";
import { beforeEach, describe, expect, it } from "vitest";

import { resetDatabase, testDeps } from "../../../packages/marketplace/test/support/seed";
import { renderSitemapSegment } from "../src/server/site-index";

const SITE = "https://mk.example";
const admin: Actor = { type: "user", userId: "usr_sitemap_admin", scopes: ["admin"] };

let deps: MarketplaceDeps;

async function publishHome(noindex: boolean): Promise<void> {
  const created = await createPage(deps, admin, { slug: "home", kind: "landing", title: "Home" });
  const edited = await setPageSeo(deps, admin, { pageId: created.page.id, expectedRevisionId: created.draft.revision.id, seo: { noindex } });
  await publishPage(deps, admin, { pageId: created.page.id, revisionId: edited.draft.revision.id });
}

async function pageLocs(): Promise<string[]> {
  const xml = (await renderSitemapSegment(deps, SITE, { kind: "pages" })) ?? "";
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");
}

beforeEach(async () => {
  deps = testDeps();
  await resetDatabase(deps);
  await deps.db.batch([deps.db.delete(pagePublications), deps.db.delete(pageRevisions), deps.db.delete(pages)]);
  await deps.db.insert(user).values({ id: admin.userId ?? "", name: "Sitemap admin", email: "sitemap-admin@example.test" }).onConflictDoNothing();
});

describe("pages sitemap", () => {
  it("lists the built-in home when no page is published at /", async () => {
    expect(await pageLocs()).toContain(`${SITE}/`);
  });

  it("lists a published, indexable home page once", async () => {
    await publishHome(false);
    expect((await pageLocs()).filter((loc) => loc === `${SITE}/`)).toHaveLength(1);
  });

  it("pages through published pages beyond one read's bound", async () => {
    const template = await createPage(deps, admin, { slug: "bulk-template", kind: "landing", title: "Bulk" });
    await publishPage(deps, admin, { pageId: template.page.id, revisionId: template.draft.revision.id });
    const total = MAX_PUBLISHED_PAGES_LISTED + 5;
    // Clone the template's published revision into `total` published pages in three statements.
    const d1 = deps.db.$client;
    await d1.batch([
      d1
        .prepare(
          `insert into pages (id, slug, kind, title, created_at, updated_at)
           with recursive n(i) as (select 1 union all select i + 1 from n where i < ?1)
           select 'pg_bulk_' || printf('%05d', i), 'bulk-' || printf('%05d', i), kind, title, created_at, updated_at
           from n, pages where pages.id = ?2`,
        )
        .bind(total, template.page.id),
      d1
        .prepare(
          `insert into page_revisions (id, page_id, number, document, created_at)
           select 'pr_bulk_' || substr(p.id, 9), p.id, 1, r.document, r.created_at
           from pages p, page_revisions r where p.id like 'pg_bulk_%' and r.id = ?1`,
        )
        .bind(template.draft.revision.id),
      d1.prepare("update pages set published_revision_id = 'pr_bulk_' || substr(id, 9) where id like 'pg_bulk_%'"),
    ]);

    const locs = await pageLocs();
    expect(locs).toContain(`${SITE}/bulk-00001`);
    expect(locs).toContain(`${SITE}/bulk-${String(total).padStart(5, "0")}`);
    expect(locs).toContain(`${SITE}/bulk-template`);
    // Built-in home, two static routes, the template and every clone, each once.
    expect(locs).toHaveLength(3 + 1 + total);
    expect(new Set(locs).size).toBe(locs.length);
  }, 60_000);

  it("omits / when the published home page is noindex", async () => {
    await publishHome(true);
    const locs = await pageLocs();
    expect(locs).not.toContain(`${SITE}/`);
    expect(locs).toContain(`${SITE}/packages`);
  });
});
