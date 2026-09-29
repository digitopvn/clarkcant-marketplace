import { MarketplaceError, type Actor } from "@marketplace/contracts";
import { pagePublications, pageRevisions, pages, user } from "@marketplace/db";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureDefaultPages, getPublishedPage, renderPageDocument, type MarketplaceDeps } from "../../src";
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

  it("creates and publishes the landing and about pages once, through the page commands", async () => {
    expect(await ensureDefaultPages(deps, admin)).toEqual({ created: ["home", "about"], existing: [] });
    expect(await ensureDefaultPages(deps, admin)).toEqual({ created: [], existing: ["home", "about"] });

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
});
