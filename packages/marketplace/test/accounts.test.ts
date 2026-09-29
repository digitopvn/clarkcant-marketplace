import {
  ANONYMOUS_ACTOR,
  MarketplaceError,
  requireScope,
  scopesForAccount,
  type Actor,
} from "@marketplace/contracts";
import {
  apiTokens,
  auditEvents,
  clarkcantDeviceLinks,
  media,
  member,
  oauthClient,
  oauthConsent,
  organization,
  packages,
  publishers,
  session,
  user,
} from "@marketplace/db";
import { and, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  createApiToken,
  createPublisher,
  deleteAccount,
  exportAccountData,
  generateApiTokenPlaintext,
  getAccountProfile,
  hashApiToken,
  inviteMember,
  linkDevice,
  listApiTokens,
  listDeviceLinks,
  listOAuthGrants,
  revokeApiToken,
  revokeOAuthGrant,
  unlinkDevice,
  verifyApiToken,
} from "../src";
import { seedAccount, tokenActor, uniqueEmail } from "./support/accounts";
import { seedPackage, testDeps } from "./support/seed";

const deps = testDeps();

async function expectError(promise: Promise<unknown>, code: MarketplaceError["code"]) {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof MarketplaceError && error.code === code);
}

describe("scopes", () => {
  it("gives users account and submit scopes and admins everything", () => {
    expect(scopesForAccount(false)).toEqual(
      expect.arrayContaining(["account:read", "account:write", "packages:submit", "publishers:write"]),
    );
    expect(scopesForAccount(false)).not.toContain("admin");
    expect(scopesForAccount(false)).not.toContain("pages:publish");
    expect(scopesForAccount(true)).toEqual(expect.arrayContaining(["admin", "pages:publish", "packages:curate"]));
  });

  it("answers 401 for anonymous callers and 403 for authenticated callers lacking a scope", () => {
    expect(() => requireScope(ANONYMOUS_ACTOR, "account:read")).toThrowError(
      expect.objectContaining({ code: "unauthorized" }),
    );
    const reader: Actor = { type: "token", userId: "usr_x", tokenId: "tok_x", scopes: ["account:read"] };
    expect(() => requireScope(reader, "pages:write")).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(() => requireScope({ ...reader, scopes: ["admin"] }, "pages:write")).not.toThrow();
  });
});

describe("API tokens", () => {
  it("stores only a SHA-256 hash and returns the plaintext once", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("tok") });
    const created = await createApiToken(deps, account, { name: "CLI", scopes: ["account:read", "packages:submit"] });

    expect(created.token).toMatch(/^cmk_[A-Za-z0-9_-]{43}$/);
    const [row] = await deps.db.select().from(apiTokens).where(eq(apiTokens.id, created.id));
    expect(row?.tokenHash).toBe(await hashApiToken(created.token));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(created.expiresAt).not.toBeNull();

    const listed = await listApiTokens(deps, account);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("token");
  });

  it("verifies live tokens, records last use and rejects revoked, expired and unknown ones", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("verify") });
    const created = await createApiToken(deps, account, { name: "agent", scopes: ["account:read"] });

    const verified = await verifyApiToken(deps, created.token);
    expect(verified).toEqual({ tokenId: created.id, userId: account.userId, scopes: ["account:read"] });
    const [used] = await deps.db.select().from(apiTokens).where(eq(apiTokens.id, created.id));
    expect(used?.lastUsedAt).not.toBeNull();

    expect(await verifyApiToken(deps, generateApiTokenPlaintext())).toBeNull();
    expect(await verifyApiToken(deps, "cmk_short")).toBeNull();

    const revoked = await revokeApiToken(deps, account, created.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(await verifyApiToken(deps, created.token)).toBeNull();

    const expiring = await createApiToken(deps, account, { name: "short", scopes: ["account:read"], expiresInDays: 1 });
    const later = { ...deps, now: () => new Date(Date.now() + 2 * 86_400_000) };
    expect(await verifyApiToken(later, expiring.token)).toBeNull();
  });

  it("never mints a token broader than the creating credential", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("narrow") });
    await expectError(createApiToken(deps, account, { name: "x", scopes: ["pages:publish"] }), "forbidden");
    const narrow = tokenActor(account, ["account:write", "account:read"]);
    await expectError(createApiToken(deps, narrow, { name: "x", scopes: ["packages:submit"] }), "forbidden");
    await expectError(createApiToken(deps, ANONYMOUS_ACTOR, { name: "x", scopes: ["account:read"] }), "unauthorized");

    const admin = await seedAccount(deps, { email: uniqueEmail("admin"), admin: true });
    const adminToken = await createApiToken(deps, admin, { name: "builder", scopes: ["pages:write", "pages:publish"] });
    expect(adminToken.scopes).toEqual(["pages:write", "pages:publish"]);
  });

  it("lets only a signed-in session create or revoke tokens, whatever the caller", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("session-only") });
    const created = await createApiToken(deps, account, { name: "mine", scopes: ["account:read"] });
    const sessionRequired = (error: unknown) =>
      error instanceof MarketplaceError &&
      error.code === "forbidden" &&
      (error.details as { reason?: string } | undefined)?.reason === "session_required";

    // Even a token holding every scope the account has, or an OAuth grant, cannot mint or revoke tokens.
    for (const token of [tokenActor(account, account.scopes), tokenActor(account, ["account:write", "account:read"], "oauth:desktop")]) {
      await expect(createApiToken(deps, token, { name: "x", scopes: ["account:read"] })).rejects.toSatisfy(sessionRequired);
      await expect(revokeApiToken(deps, token, created.id)).rejects.toSatisfy(sessionRequired);
    }
    expect((await listApiTokens(deps, account)).find((token) => token.id === created.id)?.revokedAt).toBeNull();
  });

  it("does not let one account revoke another's token", async () => {
    const owner = await seedAccount(deps, { email: uniqueEmail("owner") });
    const other = await seedAccount(deps, { email: uniqueEmail("other") });
    const created = await createApiToken(deps, owner, { name: "mine", scopes: ["account:read"] });
    await expectError(revokeApiToken(deps, other, created.id), "not_found");
  });
});

describe("ClarkCant device links", () => {
  it("links idempotently per principal, lists and unlinks", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("device") });
    const first = await linkDevice(deps, account, { localPrincipalId: "prin_abc123", deviceLabel: "Studio Mac" });
    const again = await linkDevice(deps, account, { localPrincipalId: "prin_abc123", deviceLabel: "Studio Mac (renamed)" });
    expect(again.id).toBe(first.id);
    expect(await listDeviceLinks(deps, account)).toEqual([expect.objectContaining({ deviceLabel: "Studio Mac (renamed)" })]);

    await unlinkDevice(deps, account, first.id);
    expect(await listDeviceLinks(deps, account)).toEqual([]);
    await expectError(unlinkDevice(deps, account, first.id), "not_found");

    const relinked = await linkDevice(deps, account, { localPrincipalId: "prin_abc123", deviceLabel: "Back" });
    expect(relinked.id).toBe(first.id);
    expect(await listDeviceLinks(deps, account)).toHaveLength(1);
  });

  it("lets a devices:link credential manage its own links and nothing else on the account", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("device-scope") });
    const linker = tokenActor(account, ["devices:link"]);
    const link = await linkDevice(deps, linker, { localPrincipalId: "prin_scoped1", deviceLabel: "Desktop" });
    expect(await listDeviceLinks(deps, linker)).toEqual([expect.objectContaining({ id: link.id })]);
    await unlinkDevice(deps, linker, link.id);

    await expectError(createApiToken(deps, linker, { name: "x", scopes: ["devices:link"] }), "forbidden");
    await expectError(revokeOAuthGrant(deps, linker, "some-client"), "forbidden");
    await expectError(deleteAccount(deps, linker), "forbidden");
    await expectError(getAccountProfile(deps, linker), "forbidden");
    await expectError(createPublisher(deps, linker, { slug: "nope-devices", name: "Nope" }), "forbidden");

    // Another account's link stays out of reach.
    const other = await seedAccount(deps, { email: uniqueEmail("device-other") });
    const foreign = await linkDevice(deps, other, { localPrincipalId: "prin_foreign1", deviceLabel: "Theirs" });
    await expectError(unlinkDevice(deps, linker, foreign.id), "not_found");
  });

  it("rejects ids that are not ClarkCant local principals", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("bad-device") });
    await expectError(linkDevice(deps, account, { localPrincipalId: "user_1", deviceLabel: "x" }), "validation_failed");
    await expectError(linkDevice(deps, account, { localPrincipalId: "prin_a-b", deviceLabel: "x" }), "validation_failed");
  });
});

async function seedOAuthGrant(userId: string, clientId: string) {
  const now = new Date();
  await deps.db.insert(oauthClient).values({ id: deps.ids("oc"), clientId, name: "ClarkCant Desktop", redirectUris: ["http://127.0.0.1/cb"] });
  await deps.db
    .insert(oauthConsent)
    .values({ id: deps.ids("ocs"), clientId, userId, scopes: ["openid", "account:read"], createdAt: now, updatedAt: now });
}

describe("account export", () => {
  it("contains the account's data and never its credentials", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("export"), emailVerified: true });
    const token = await createApiToken(deps, account, { name: "export-cli", scopes: ["account:read"] });
    await linkDevice(deps, account, { localPrincipalId: "prin_export1", deviceLabel: "Laptop" });
    const publisher = await createPublisher(deps, account, { slug: `exp-${Date.now().toString(36)}`, name: "Exporter" });
    await seedOAuthGrant(account.userId, `client-${Date.now().toString(36)}`);

    const data = await exportAccountData(deps, account);
    expect(data.profile).toMatchObject({ id: account.userId, emailVerified: true, role: "user" });
    expect(data.apiTokens).toEqual([expect.objectContaining({ id: token.id, name: "export-cli" })]);
    expect(data.deviceLinks).toEqual([expect.objectContaining({ localPrincipalId: "prin_export1", revokedAt: null })]);
    expect(data.publishers).toEqual([expect.objectContaining({ id: publisher.id, role: "owner" })]);
    expect(data.oauthConsents).toHaveLength(1);
    expect(data.auditEvents.map((event) => event.action)).toEqual(
      expect.arrayContaining(["api_token.created", "device_link.linked", "publisher.created"]),
    );
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(token.token);
    expect(serialized).not.toContain(await hashApiToken(token.token));

    const profile = await getAccountProfile(deps, account);
    expect(profile.scopes).toEqual(account.scopes);
  });
});

describe("account deletion", () => {
  it("removes the account and everything tied to it, and audits the deletion", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("delete") });
    const token = await createApiToken(deps, account, { name: "doomed", scopes: ["account:read"] });
    await linkDevice(deps, account, { localPrincipalId: "prin_gone1", deviceLabel: "Old PC" });
    const solo = await createPublisher(deps, account, { slug: `solo-${Date.now().toString(36)}`, name: "Solo" });
    const packageId = await seedPackage(deps, { name: `@solo/pkg-${Date.now().toString(36)}` });
    await deps.db.update(packages).set({ publisherId: solo.id }).where(eq(packages.id, packageId));
    const clientId = `client-del-${Date.now().toString(36)}`;
    await seedOAuthGrant(account.userId, clientId);
    await deps.db.insert(session).values({
      id: deps.ids("ses"),
      token: deps.ids("sestok"),
      userId: account.userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const bytes = new TextEncoder().encode("avatar");
    const mediaKey = `sha256/te/st/${Date.now().toString(36)}.png`;
    await env.MEDIA.put(mediaKey, bytes);
    const mediaId = deps.ids("med");
    await deps.db.insert(media).values({
      id: mediaId,
      sha256: `sha-${mediaId}`,
      r2Key: mediaKey,
      contentType: "image/png",
      bytes: bytes.length,
      ownerUserId: account.userId,
    });

    const deleted: string[] = [];
    const result = await deleteAccount({ ...deps, media: env.MEDIA }, account, {
      deleteMedia: async (id) => {
        deleted.push(id);
        await env.MEDIA.delete(mediaKey);
        await deps.db.delete(media).where(eq(media.id, id));
        return true;
      },
    });

    expect(result).toEqual({
      deleted: true,
      removed: { apiTokens: 1, deviceLinks: 1, oauthGrants: 1, publishers: 1, media: 1 },
    });
    expect(deleted).toEqual([mediaId]);
    expect(await env.MEDIA.get(mediaKey)).toBeNull();
    expect(await deps.db.select().from(user).where(eq(user.id, account.userId))).toEqual([]);
    expect(await deps.db.select().from(session).where(eq(session.userId, account.userId))).toEqual([]);
    expect(await deps.db.select().from(apiTokens).where(eq(apiTokens.userId, account.userId))).toEqual([]);
    expect(await verifyApiToken(deps, token.token)).toBeNull();
    expect(await deps.db.select().from(clarkcantDeviceLinks).where(eq(clarkcantDeviceLinks.userId, account.userId))).toEqual([]);
    expect(await deps.db.select().from(oauthConsent).where(eq(oauthConsent.clientId, clientId))).toEqual([]);
    expect(await deps.db.select().from(publishers).where(eq(publishers.id, solo.id))).toEqual([]);
    expect(await deps.db.select().from(member).where(eq(member.userId, account.userId))).toEqual([]);
    const [orphaned] = await deps.db.select().from(packages).where(eq(packages.id, packageId));
    expect(orphaned?.publisherId).toBeNull();

    const audit = await deps.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "account.deleted"), eq(auditEvents.subjectId, account.userId)));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.data)).not.toContain("@example.test");
  });

  it("still succeeds when the search re-sync after the committed deletion fails, and logs it", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("delete-sync") });
    const solo = await createPublisher(deps, account, { slug: `sync-${Date.now().toString(36)}`, name: "Sync" });
    const packageId = await seedPackage(deps, { name: `@sync/pkg-${Date.now().toString(36)}` });
    await deps.db.update(packages).set({ publisherId: solo.id }).where(eq(packages.id, packageId));

    // The deletion's own batch runs; every later batch (the search re-sync) fails.
    let batches = 0;
    const db = new Proxy(deps.db, {
      get(target, property) {
        if (property === "batch") {
          return (statements: Parameters<typeof target.batch>[0]) => {
            batches += 1;
            return batches === 1 ? target.batch(statements) : Promise.reject(new Error("D1 unavailable"));
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deleteAccount({ ...deps, db }, account)).resolves.toMatchObject({ deleted: true });
      expect(batches).toBe(2);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(packageId), expect.any(Error));
    } finally {
      logged.mockRestore();
    }
    expect(await deps.db.select().from(user).where(eq(user.id, account.userId))).toEqual([]);
  });

  it("refuses token credentials and refuses to orphan a team publisher", async () => {
    const owner = await seedAccount(deps, { email: uniqueEmail("team-owner") });
    const teammateEmail = uniqueEmail("teammate");
    const teammate = await seedAccount(deps, { email: teammateEmail });
    const team = await createPublisher(deps, owner, { slug: `team-${Date.now().toString(36)}`, name: "Team" });
    const [org] = await deps.db.select().from(organization).where(eq(organization.slug, team.slug));
    await deps.db
      .insert(member)
      .values({ id: deps.ids("mem"), organizationId: org!.id, userId: teammate.userId, role: "member", createdAt: new Date() });

    await expectError(deleteAccount(deps, tokenActor(owner, ["account:write"])), "forbidden");
    await expectError(deleteAccount(deps, owner), "conflict");

    // The member can leave by deleting their account; the team keeps its owner.
    await deleteAccount(deps, teammate);
    expect(await deps.db.select().from(publishers).where(eq(publishers.id, team.id))).toHaveLength(1);
    await inviteMember(deps, owner, team.id, { email: teammateEmail });
  });
});

describe("OAuth grants", () => {
  it("lists and revokes a client's consent", async () => {
    const account = await seedAccount(deps, { email: uniqueEmail("oauth") });
    const clientId = `client-rev-${Date.now().toString(36)}`;
    await seedOAuthGrant(account.userId, clientId);
    expect(await listOAuthGrants(deps, account)).toEqual([
      expect.objectContaining({ clientId, clientName: "ClarkCant Desktop", scopes: ["openid", "account:read"] }),
    ]);
    await revokeOAuthGrant(deps, account, clientId);
    expect(await listOAuthGrants(deps, account)).toEqual([]);
    await expectError(revokeOAuthGrant(deps, account, clientId), "not_found");
  });
});
