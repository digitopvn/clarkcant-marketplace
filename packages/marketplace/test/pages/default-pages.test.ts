import { MarketplaceError, type Actor } from "@marketplace/contracts";
import { pagePublications, pageRevisions, pages, user } from "@marketplace/db";
import { beforeAll, describe, expect, it } from "vitest";

import { LEGAL_PAGES, ensureDefaultPages, getPublishedPage, renderPageDocument, type MarketplaceDeps } from "../../src";
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

  it("creates and publishes the landing, about and policy pages once, through the page commands", async () => {
    const slugs = ["home", "about", "terms", "privacy", "cookies", "refunds", "gdpr", "security", "subprocessors"];
    expect(LEGAL_PAGES.map((page) => page.slug)).toEqual(slugs.slice(2));
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
