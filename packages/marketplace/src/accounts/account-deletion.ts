import {
  MarketplaceError,
  requireScope,
  requireUser,
  type AccountDeletionResult,
  type Actor,
} from "@marketplace/contracts";
import {
  apiTokens,
  clarkcantDeviceLinks,
  deviceCode,
  media,
  member,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  organization,
  publishers,
  user,
} from "@marketplace/db";
import { count, eq, inArray } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { countMembers } from "../publishers/publisher-service";

/**
 * Deletes one media object (D1 row and R2 object) unless something still references it, returning whether it was
 * deleted. The media feature supplies this (`deleteMediaIfUnreferenced` in `@marketplace/media`), because it knows
 * how media is stored and referenced.
 */
export type DeleteMediaIfUnreferenced = (mediaId: string) => Promise<boolean>;

/**
 * Removes the account's media: unreferenced objects are deleted; objects still used elsewhere (e.g. a public
 * listing preview) are kept and lose their owner when the user row goes (`owner_user_id` is `ON DELETE SET NULL`).
 */
export async function removeOwnedMedia(
  deps: MarketplaceDeps,
  userId: string,
  deleteMedia: DeleteMediaIfUnreferenced | undefined,
): Promise<number> {
  const owned = await deps.db.select({ id: media.id }).from(media).where(eq(media.ownerUserId, userId));
  if (owned.length === 0) return 0;
  if (!deleteMedia) {
    throw new MarketplaceError("configuration_error", "Media storage is not available; cannot remove account media");
  }
  let removed = 0;
  for (const row of owned) {
    if (await deleteMedia(row.id)) removed += 1;
  }
  return removed;
}

export interface DeleteAccountOptions {
  deleteMedia?: DeleteMediaIfUnreferenced;
}

/**
 * Deletes the caller's account and everything tied to it: sessions, sign-in methods, passkeys, API tokens, device
 * links, OAuth grants (tokens, consents, and clients the user registered), memberships, publishers where the user is
 * the only member, and owned media. Listings of a removed publisher stay indexed but lose their publisher.
 *
 * Requires a signed-in session: an API or OAuth token cannot delete the account it belongs to. Refuses (conflict)
 * while the user is the only owner of a publisher that has other members, so a team is never left without an owner.
 * The audit record keeps only ids and counts.
 */
export async function deleteAccount(
  deps: MarketplaceDeps,
  actor: Actor,
  options: DeleteAccountOptions = {},
): Promise<AccountDeletionResult> {
  requireScope(actor, "account:write");
  const userId = requireUser(actor);
  if (actor.type !== "user") {
    throw new MarketplaceError("forbidden", "Deleting an account needs a signed-in session, not a token");
  }

  const memberships = await deps.db
    .select({ organizationId: member.organizationId, role: member.role, publisherId: publishers.id, slug: publishers.slug })
    .from(member)
    .leftJoin(publishers, eq(publishers.organizationId, member.organizationId))
    .where(eq(member.userId, userId));
  const allMembers = await countMembers(deps, memberships.map((row) => row.organizationId));

  const soleMemberOrgs: string[] = [];
  const blocking: string[] = [];
  for (const membership of memberships) {
    const others = allMembers.filter((row) => row.organizationId === membership.organizationId && row.userId !== userId);
    if (others.length === 0) soleMemberOrgs.push(membership.organizationId);
    else if (membership.role === "owner" && !others.some((row) => row.role === "owner")) {
      blocking.push(membership.slug ?? membership.organizationId);
    }
  }
  if (blocking.length > 0) {
    throw new MarketplaceError("conflict", "Transfer ownership of these publishers before deleting your account", {
      details: { publishers: blocking },
    });
  }

  const total = async (rows: Promise<{ value: number }[]>) => (await rows)[0]?.value ?? 0;
  const counted = { value: count() };
  const [apiTokenCount, deviceLinkCount, consentCount, accessCount, refreshCount] = await Promise.all([
    total(deps.db.select(counted).from(apiTokens).where(eq(apiTokens.userId, userId))),
    total(deps.db.select(counted).from(clarkcantDeviceLinks).where(eq(clarkcantDeviceLinks.userId, userId))),
    total(deps.db.select(counted).from(oauthConsent).where(eq(oauthConsent.userId, userId))),
    total(deps.db.select(counted).from(oauthAccessToken).where(eq(oauthAccessToken.userId, userId))),
    total(deps.db.select(counted).from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId))),
  ]);
  const oauthGrantCount = consentCount + accessCount + refreshCount;

  const soleMemberPublishers = memberships.filter(
    (row) => row.publisherId !== null && soleMemberOrgs.includes(row.organizationId),
  );

  const mediaRemoved = await removeOwnedMedia(deps, userId, options.deleteMedia);

  const audit = prepareAuditEvent(deps, {
    actor: { type: "user", id: userId },
    action: "account.deleted",
    subject: { type: "user", id: userId },
    data: {
      publishersRemoved: soleMemberPublishers.map((row) => row.publisherId),
      apiTokens: apiTokenCount,
      deviceLinks: deviceLinkCount,
      oauthGrants: oauthGrantCount,
      media: mediaRemoved,
    },
  });

  const publisherIds = soleMemberPublishers.flatMap((row) => (row.publisherId === null ? [] : [row.publisherId]));
  await deps.db.batch([
    // Revocation is explicit rather than left to cascades, so it holds even for rows without a foreign key.
    deps.db.delete(deviceCode).where(eq(deviceCode.userId, userId)),
    deps.db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId)),
    deps.db.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId)),
    deps.db.delete(oauthConsent).where(eq(oauthConsent.userId, userId)),
    deps.db.delete(oauthClient).where(eq(oauthClient.userId, userId)),
    deps.db.delete(apiTokens).where(eq(apiTokens.userId, userId)),
    deps.db.delete(clarkcantDeviceLinks).where(eq(clarkcantDeviceLinks.userId, userId)),
    ...(publisherIds.length > 0 ? [deps.db.delete(publishers).where(inArray(publishers.id, publisherIds))] : []),
    ...(soleMemberOrgs.length > 0 ? [deps.db.delete(organization).where(inArray(organization.id, soleMemberOrgs))] : []),
    // Sessions, sign-in methods, passkeys, memberships, invitations sent and claims cascade from the user row.
    deps.db.delete(user).where(eq(user.id, userId)),
    audit.statement,
  ]);

  return {
    deleted: true,
    removed: {
      apiTokens: apiTokenCount,
      deviceLinks: deviceLinkCount,
      oauthGrants: oauthGrantCount,
      publishers: publisherIds.length,
      media: mediaRemoved,
    },
  };
}
