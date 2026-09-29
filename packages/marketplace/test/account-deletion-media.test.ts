import { media, packages, packagesFts, pageRevisions, pages } from "@marketplace/db";
import { deleteMediaIfUnreferenced } from "@marketplace/media";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createPublisher, deleteAccount, syncPackageSearchDocument } from "../src";
import { seedAccount, uniqueEmail } from "./support/accounts";
import { seedPackage, testDeps } from "./support/seed";

const deps = { ...testDeps(), media: env.MEDIA };
const mediaDeps = { db: deps.db, bucket: env.MEDIA, ids: deps.ids, now: deps.now };

async function storeOwnedMedia(ownerUserId: string, label: string): Promise<{ id: string; key: string }> {
  const id = deps.ids("med");
  const key = `sha256/te/st/${id}.png`;
  await env.MEDIA.put(key, new TextEncoder().encode(label));
  await deps.db.insert(media).values({ id, sha256: `sha-${id}`, r2Key: key, contentType: "image/png", bytes: label.length, ownerUserId });
  return { id, key };
}

/** A page whose only revision (a draft, never published) shows `mediaId` in a media block. */
async function pageUsing(mediaId: string): Promise<void> {
  const pageId = deps.ids("page");
  const revisionId = deps.ids("rev");
  const now = deps.now();
  await deps.db.batch([
    deps.db.insert(pages).values({ id: pageId, slug: `uses-${pageId.slice(-8)}`, kind: "custom", title: "Uses media", createdAt: now, updatedAt: now }),
    deps.db.insert(pageRevisions).values({
      id: revisionId,
      pageId,
      number: 1,
      document: {
        schemaVersion: 1,
        layout: { id: "editorial", version: 1 },
        meta: { title: "Uses media" },
        blocks: [{ id: "m", type: "media", version: 1, props: { mediaId, alt: "Diagram" } }],
      },
      createdAt: now,
    }),
    deps.db.update(pages).set({ currentDraftRevisionId: revisionId }).where(eq(pages.id, pageId)),
  ]);
}

describe("account deletion and media", () => {
  it("keeps media a page revision uses (clearing its owner) and deletes only unreferenced media", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("media-owner") });
    const used = await storeOwnedMedia(account.userId, "used-by-page");
    const unused = await storeOwnedMedia(account.userId, "unused");
    // An id that merely starts with the used one must not count as a reference to it.
    const prefixed = await storeOwnedMedia(account.userId, "prefixed");
    await pageUsing(used.id);
    await pageUsing(`${prefixed.id}x`);

    const result = await deleteAccount(deps, account, { deleteMedia: (id) => deleteMediaIfUnreferenced(mediaDeps, id) });

    expect(result.removed.media).toBe(2);
    const [kept] = await deps.db.select().from(media).where(eq(media.id, used.id));
    expect(kept).toMatchObject({ id: used.id, ownerUserId: null });
    expect(await env.MEDIA.head(used.key)).not.toBeNull();
    expect(await deps.db.select().from(media).where(eq(media.id, unused.id))).toEqual([]);
    expect(await env.MEDIA.head(unused.key)).toBeNull();
    expect(await deps.db.select().from(media).where(eq(media.id, prefixed.id))).toEqual([]);
  });

  it("drops a removed publisher's name from its packages' search text", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("search-owner") });
    const slug = `zephyrsolo${Date.now().toString(36)}`;
    const publisher = await createPublisher(deps, account, { slug, name: "Zephyr Solo" });
    const packageId = await seedPackage(deps, { name: `@zephyr/pkg-${Date.now().toString(36)}` });
    await deps.db.update(packages).set({ publisherId: publisher.id }).where(eq(packages.id, packageId));
    await syncPackageSearchDocument(deps, packageId);
    const before = await deps.db.select({ publisher: packagesFts.publisher }).from(packagesFts).where(eq(packagesFts.packageId, packageId));
    expect(before).toEqual([{ publisher: `Zephyr Solo ${slug}` }]);

    await deleteAccount(deps, account, { deleteMedia: (id) => deleteMediaIfUnreferenced(mediaDeps, id) });

    const after = await deps.db.select({ publisher: packagesFts.publisher }).from(packagesFts).where(eq(packagesFts.packageId, packageId));
    expect(after).toEqual([{ publisher: "" }]);
  });
});
