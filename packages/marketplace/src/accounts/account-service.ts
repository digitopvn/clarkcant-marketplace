import {
  MarketplaceError,
  requireScope,
  requireUser,
  type AccountExport,
  type AccountProfile,
  type Actor,
  type OwnedPackage,
} from "@marketplace/contracts";
import {
  account,
  apiTokens,
  auditEvents,
  clarkcantDeviceLinks,
  media,
  member,
  oauthConsent,
  packageClaims,
  packages,
  passkey,
  publishers,
  session,
  user,
} from "@marketplace/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { toApiToken } from "./api-tokens";
import { toDeviceLink } from "./device-links";

type UserRow = typeof user.$inferSelect;

async function loadUser(deps: MarketplaceDeps, userId: string): Promise<UserRow> {
  const [row] = await deps.db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!row) throw new MarketplaceError("unauthorized", "This account no longer exists");
  return row;
}

export async function getAccountProfile(deps: MarketplaceDeps, actor: Actor): Promise<AccountProfile> {
  requireScope(actor, "account:read");
  const row = await loadUser(deps, requireUser(actor));
  return { ...toProfile(row), scopes: [...actor.scopes] };
}

/** Listings owned by any publisher the caller belongs to, whatever their curation state. */
export async function listOwnedPackages(deps: MarketplaceDeps, actor: Actor): Promise<OwnedPackage[]> {
  requireScope(actor, "account:read");
  const rows = await deps.db
    .select({
      id: packages.id,
      name: packages.name,
      displayName: packages.displayName,
      latestVersion: packages.latestVersion,
      curationStatus: packages.curationStatus,
      verifiedPublisher: packages.verifiedPublisher,
      publisherId: publishers.id,
      publisherSlug: publishers.slug,
      publisherName: publishers.name,
    })
    .from(member)
    .innerJoin(publishers, eq(publishers.organizationId, member.organizationId))
    .innerJoin(packages, eq(packages.publisherId, publishers.id))
    .where(eq(member.userId, requireUser(actor)))
    .orderBy(asc(packages.name));
  return rows.map(({ publisherId, publisherSlug, publisherName, ...listing }) => ({
    ...listing,
    publisher: { id: publisherId, slug: publisherSlug, name: publisherName },
  }));
}

/**
 * Everything stored about the account, as JSON. Credentials (password hashes, token hashes, OAuth tokens, passkey
 * keys) are never included; their existence is described instead.
 */
export async function exportAccountData(deps: MarketplaceDeps, actor: Actor): Promise<AccountExport> {
  requireScope(actor, "account:read");
  const userId = requireUser(actor);
  const profile = await loadUser(deps, userId);
  const [signIns, sessions, passkeys, tokens, links, consents, memberships, claims, ownedMedia, audit] =
    await Promise.all([
      deps.db
        .select({ provider: account.providerId, createdAt: account.createdAt })
        .from(account)
        .where(eq(account.userId, userId)),
      deps.db
        .select({
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        })
        .from(session)
        .where(eq(session.userId, userId))
        .orderBy(desc(session.createdAt)),
      deps.db
        .select({ name: passkey.name, deviceType: passkey.deviceType, createdAt: passkey.createdAt })
        .from(passkey)
        .where(eq(passkey.userId, userId)),
      deps.db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.createdAt)),
      deps.db
        .select()
        .from(clarkcantDeviceLinks)
        .where(eq(clarkcantDeviceLinks.userId, userId))
        .orderBy(desc(clarkcantDeviceLinks.createdAt)),
      deps.db
        .select({ clientId: oauthConsent.clientId, scopes: oauthConsent.scopes, createdAt: oauthConsent.createdAt })
        .from(oauthConsent)
        .where(eq(oauthConsent.userId, userId)),
      deps.db
        .select({ id: publishers.id, slug: publishers.slug, name: publishers.name, role: member.role })
        .from(member)
        .innerJoin(publishers, eq(publishers.organizationId, member.organizationId))
        .where(eq(member.userId, userId)),
      deps.db
        .select({
          id: packageClaims.id,
          packageId: packageClaims.packageId,
          publisherId: packageClaims.publisherId,
          status: packageClaims.status,
          createdAt: packageClaims.createdAt,
        })
        .from(packageClaims)
        .where(eq(packageClaims.requestedBy, userId)),
      deps.db
        .select({ id: media.id, sha256: media.sha256, contentType: media.contentType, bytes: media.bytes, createdAt: media.createdAt })
        .from(media)
        .where(eq(media.ownerUserId, userId)),
      deps.db
        .select({
          action: auditEvents.action,
          subjectType: auditEvents.subjectType,
          subjectId: auditEvents.subjectId,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(and(eq(auditEvents.actorType, "user"), eq(auditEvents.actorId, userId)))
        .orderBy(desc(auditEvents.createdAt))
        .limit(1000),
    ]);

  const tokenIds = tokens.map((token) => token.id);
  const tokenAudit =
    tokenIds.length === 0
      ? []
      : await deps.db
          .select({
            action: auditEvents.action,
            subjectType: auditEvents.subjectType,
            subjectId: auditEvents.subjectId,
            createdAt: auditEvents.createdAt,
          })
          .from(auditEvents)
          .where(and(eq(auditEvents.actorType, "token"), inArray(auditEvents.actorId, tokenIds)))
          .limit(1000);

  const iso = (value: Date) => value.toISOString();
  return {
    exportedAt: iso(deps.now()),
    profile: toProfile(profile),
    signInMethods: signIns.map((row) => ({ provider: row.provider, createdAt: iso(row.createdAt) })),
    sessions: sessions.map((row) => ({ ...row, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt) })),
    passkeys: passkeys.map((row) => ({ ...row, createdAt: row.createdAt ? iso(row.createdAt) : null })),
    apiTokens: tokens.map(toApiToken),
    deviceLinks: links.map((row) => ({ ...toDeviceLink(row), revokedAt: row.revokedAt ? iso(row.revokedAt) : null })),
    oauthConsents: consents.map((row) => ({
      clientId: row.clientId,
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      createdAt: iso(row.createdAt),
    })),
    publishers: memberships,
    packageClaims: claims.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
    media: ownedMedia.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
    auditEvents: [...audit, ...tokenAudit]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
  };
}

function toProfile(row: UserRow): Omit<AccountProfile, "scopes"> {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
    role: row.role === "admin" ? "admin" : "user",
    createdAt: row.createdAt.toISOString(),
  };
}
