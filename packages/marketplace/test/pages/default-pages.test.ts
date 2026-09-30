import { MarketplaceError, type Actor } from "@marketplace/contracts";
import { pagePublications, pageRevisions, pages, user } from "@marketplace/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_PAGES_ACTOR,
  DISCOVERY_KEYWORDS,
  LEGAL_PAGES,
  createPage,
  ensureDefaultPages,
  ensureDefaultPagesAsSystem,
  getPage,
  getPublishedPage,
  listAuditEventsForSubject,
  renderPageDocument,
  savePageDraft,
  type MarketplaceDeps,
} from "../../src";
import { createPageAsSystem } from "../../src/pages/page-service";
import { resetDatabase, seedPackage, testDeps } from "../support/seed";

const admin: Actor = { type: "user", userId: "usr_default_admin", scopes: ["admin"] };
const editor: Actor = { type: "user", userId: "usr_default_editor", scopes: ["pages:write"] };

let deps: MarketplaceDeps;

beforeAll(async () => {
  deps = testDeps();
  await resetDatabase(deps);
  await deps.db.batch([deps.db.delete(pagePublications), deps.db.delete(pageRevisions), deps.db.delete(pages)]);
  await deps.db.insert(user).values({ id: "usr_default_admin", name: "Admin", email: "default-admin@example.test" }).onConflictDoNothing();
  await seedPackage(deps, { name: "@acme/chart-widget", displayName: "Chart", description: "Charts for dashboards", publisher: { slug: "acme", name: "Acme" } });
});

describe("default pages", () => {
  it("requires pages:publish", async () => {
    await expect(ensureDefaultPages(deps, editor)).rejects.toSatisfy(
      (error) => error instanceof MarketplaceError && error.code === "forbidden",
    );
  });

  it("creates and publishes the landing, about, publisher guide and policy pages once, through the page commands", async () => {
    const slugs = ["home", "about", "publish", "terms", "privacy", "cookies", "refunds", "gdpr", "security", "subprocessors"];
    expect(LEGAL_PAGES.map((page) => page.slug)).toEqual(slugs.slice(3));
    expect(await ensureDefaultPages(deps, admin)).toEqual({ created: slugs, existing: [] });
    expect(await ensureDefaultPages(deps, admin)).toEqual({ created: [], existing: slugs });

    const home = await getPublishedPage(deps, "home");
    expect(home.revisionNumber).toBe(1);
    const rendered = await renderPageDocument(deps, home.document, { mode: "public", siteUrl: "https://marketplace.test", path: "/" });
    expect(rendered.diagnostics).toEqual([]);
    expect(rendered.html).toContain("curated from npm");
    // Package sections are live queries, not copied data.
    expect(rendered.html).toContain("@acme/chart-widget");
    expect(rendered.structuredData.map((item) => item["@type"])).toContain("FAQPage");

    const about = await getPublishedPage(deps, "about");
    const aboutRendered = await renderPageDocument(deps, about.document, { mode: "public", siteUrl: "https://marketplace.test", path: "/about" });
    expect(aboutRendered.markdown).toContain("# Discovery and curation for ClarkCant packages");
    expect(aboutRendered.html).toContain('href="/openapi.json"');

    const guide = await getPublishedPage(deps, "publish");
    const guideRendered = await renderPageDocument(deps, guide.document, { mode: "public", siteUrl: "https://marketplace.test", path: "/publish" });
    expect(guideRendered.diagnostics).toEqual([]);
    expect(guideRendered.markdown).toContain("# Publish a package");
    // The guide names the discovery keywords and the submit route the indexer and API actually use.
    for (const keyword of DISCOVERY_KEYWORDS) expect(guideRendered.markdown).toContain(`"${keyword}"`);
    expect(guideRendered.markdown).toContain("/api/v1/publish/submit");
    expect(guideRendered.html).toContain("clarkcant.json");
  });

  it("publishes every policy page as a legal draft that renders cleanly", async () => {
    for (const { slug } of LEGAL_PAGES) {
      const page = await getPublishedPage(deps, slug);
      expect(page.page.kind).toBe("legal");
      const rendered = await renderPageDocument(deps, page.document, { mode: "public", siteUrl: "https://marketplace.test", path: `/${slug}` });
      expect(rendered.diagnostics).toEqual([]);
      expect(rendered.markdown).toContain("Draft — requires legal review before production launch.");
    }
  });

  it("states the facts the policy pages exist to state", async () => {
    const markdown = async (slug: string) =>
      (await renderPageDocument(deps, (await getPublishedPage(deps, slug)).document, { mode: "public", siteUrl: "https://marketplace.test", path: `/${slug}` })).markdown;

    expect(await markdown("refunds")).toContain("There are no paid transactions");
    const security = await markdown("security");
    expect(security).toContain("proved control of a web domain with a DNS TXT record");
    expect(security).toContain("A person has reviewed the code, or the code is safe");
    expect(security).toContain("the marketplace does not verify attestations yet");
    const subprocessors = await markdown("subprocessors");
    expect(subprocessors).toContain("Cloudflare, Inc.");
    expect(subprocessors).toContain("only when GitHub sign-in is enabled");
    expect(subprocessors).toContain("registry.npmjs.org");
    // Undecided company facts are placeholders, never invented.
    expect(await markdown("terms")).toContain("TO BE CONFIRMED");
    expect(await markdown("cookies")).toContain("`cc_consent`");
  });
});

describe("default pages seeded by the jobs Worker", () => {
  const allSlugs = ["home", "about", "publish", "terms", "privacy", "cookies", "refunds", "gdpr", "security", "subprocessors"];

  beforeAll(async () => {
    await deps.db.batch([deps.db.delete(pagePublications), deps.db.delete(pageRevisions), deps.db.delete(pages)]);
  });

  it("creates and publishes missing pages as the system, leaving existing and edited pages alone", async () => {
    // An editor already owns /about with their own copy, unpublished.
    const custom = await createPage(deps, admin, { slug: "about", kind: "custom", title: "Our own about page" });
    // An interrupted earlier run created /terms but never published it: revision 1, no author, no publication.
    const legal = LEGAL_PAGES.find((page) => page.slug === "terms");
    if (!legal) throw new Error("terms page is missing from LEGAL_PAGES");
    const unfinished = await createPageAsSystem(deps, DEFAULT_PAGES_ACTOR, { slug: "terms", kind: "legal", document: legal.document });

    const first = await ensureDefaultPagesAsSystem(deps);
    expect(first.existing).toEqual(["about"]);
    expect(first.created).toEqual(allSlugs.filter((slug) => slug !== "about"));
    expect(await ensureDefaultPagesAsSystem(deps)).toEqual({ created: [], existing: allSlugs });

    const about = await getPage(deps, admin, custom.page.id);
    expect(about.page).toMatchObject({ title: "Our own about page", publishedRevisionId: null });
    expect((await getPublishedPage(deps, "terms")).revisionId).toBe(unfinished.draft.revision.id);

    const privacy = await getPublishedPage(deps, "privacy");
    expect(privacy.revisionNumber).toBe(1);
    const events = await listAuditEventsForSubject(deps, { type: "page", id: privacy.page.id });
    expect(events.map((event) => [event.action, event.actor])).toEqual(
      expect.arrayContaining([
        ["page.created", DEFAULT_PAGES_ACTOR],
        ["page.published", DEFAULT_PAGES_ACTOR],
      ]),
    );
    const [publication] = await deps.db.select().from(pagePublications).where(eq(pagePublications.pageId, privacy.page.id));
    expect(publication?.publishedBy).toBeNull();
  });

  it("never republishes a seeded page an editor changed", async () => {
    const live = await getPublishedPage(deps, "cookies");
    const state = await getPage(deps, admin, live.page.id);
    await savePageDraft(deps, admin, {
      pageId: live.page.id,
      expectedRevisionId: state.draft.revision.id,
      document: { ...state.draft.document, meta: { ...state.draft.document.meta, title: "Cookies (edited)" } },
    });
    expect(await ensureDefaultPagesAsSystem(deps)).toEqual({ created: [], existing: allSlugs });
    expect((await getPublishedPage(deps, "cookies")).revisionId).toBe(live.revisionId);
  });

  it("never publishes an editor's unpublished draft whose author account was deleted", async () => {
    await deps.db.batch([deps.db.delete(pagePublications), deps.db.delete(pageRevisions), deps.db.delete(pages)]);
    const departed: Actor = { type: "user", userId: "usr_default_departed", scopes: ["pages:write"] };
    await deps.db.insert(user).values({ id: "usr_default_departed", name: "Departed", email: "departed@example.test" }).onConflictDoNothing();
    const legal = LEGAL_PAGES.find((page) => page.slug === "privacy");
    if (!legal) throw new Error("privacy page is missing from LEGAL_PAGES");
    // Even a draft identical to the default is the editor's page, not an unfinished seed.
    const draft = await createPage(deps, departed, { slug: "privacy", kind: "legal", document: legal.document });
    await deps.db.delete(user).where(eq(user.id, "usr_default_departed"));
    const [revision] = await deps.db.select().from(pageRevisions).where(eq(pageRevisions.id, draft.draft.revision.id));
    expect(revision?.authorId).toBeNull();

    const result = await ensureDefaultPagesAsSystem(deps);
    expect(result.existing).toEqual(["privacy"]);
    expect(result.created).not.toContain("privacy");
    const [row] = await deps.db.select().from(pages).where(eq(pages.id, draft.page.id));
    expect(row?.publishedRevisionId).toBeNull();
    await expect(getPublishedPage(deps, "privacy")).rejects.toSatisfy(
      (error) => error instanceof MarketplaceError && error.code === "not_found",
    );
  });
});
