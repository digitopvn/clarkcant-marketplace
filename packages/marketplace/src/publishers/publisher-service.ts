import {
  MarketplaceError,
  actorHasScope,
  createPublisherInputSchema,
  inviteMemberInputSchema,
  publisherRoleSchema,
  requireScope,
  requireUser,
  toAuditActor,
  type Actor,
  type CreatePublisherInput,
  type InviteMemberInput,
  type Publisher,
  type PublisherInvitation,
  type PublisherMember,
  type PublisherRole,
} from "@marketplace/contracts";
import { invitation, member, organization, publishers, user } from "@marketplace/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";

type PublisherRow = typeof publishers.$inferSelect;

const INVITATION_TTL_MS = 7 * 86_400_000;
const MANAGER_ROLES: readonly PublisherRole[] = ["owner", "admin"];

/**
 * Publishers are backed by Better Auth organizations: the `organization`/`member`/`invitation` tables hold
 * membership, and `publishers` holds the marketplace identity that owns listings. This service is the only write
 * path for both, so every change is validated, authorized and audited in one D1 batch.
 */
export async function createPublisher(
  deps: MarketplaceDeps,
  actor: Actor,
  input: CreatePublisherInput,
): Promise<Publisher> {
  requireScope(actor, "publishers:write");
  const userId = requireUser(actor);
  const { slug, name, kind } = parseInput(createPublisherInputSchema, input);

  const taken = await deps.db
    .select({ id: publishers.id })
    .from(publishers)
    .where(eq(publishers.slug, slug))
    .union(deps.db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)));
  if (taken.length > 0) throw new MarketplaceError("conflict", `The publisher name "${slug}" is taken`);

  const now = deps.now();
  const organizationId = deps.ids("org");
  const row: PublisherRow = {
    id: deps.ids("pub"),
    slug,
    name,
    kind,
    organizationId,
    verifiedAt: null,
    createdAt: now,
  };
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "publisher.created",
    subject: { type: "publisher", id: row.id },
    data: { slug, kind },
  });
  await deps.db.batch([
    deps.db.insert(organization).values({ id: organizationId, name, slug, createdAt: now }),
    deps.db.insert(member).values({ id: deps.ids("mem"), organizationId, userId, role: "owner", createdAt: now }),
    deps.db.insert(publishers).values(row),
    audit.statement,
  ]);
  return { ...toPublisher(row), role: "owner" };
}

/** Publishers the caller belongs to, with the caller's role in each. */
export async function listMyPublishers(deps: MarketplaceDeps, actor: Actor): Promise<Publisher[]> {
  requireScope(actor, "publishers:read");
  const rows = await deps.db
    .select({ publisher: publishers, role: member.role })
    .from(member)
    .innerJoin(publishers, eq(publishers.organizationId, member.organizationId))
    .where(eq(member.userId, requireUser(actor)))
    .orderBy(asc(publishers.slug));
  return rows.map(({ publisher, role }) => ({ ...toPublisher(publisher), role: toRole(role) }));
}

export async function getPublisher(deps: MarketplaceDeps, idOrSlug: string): Promise<Publisher> {
  const [row] = await deps.db
    .select()
    .from(publishers)
    .where(or(eq(publishers.id, idOrSlug), eq(publishers.slug, idOrSlug)))
    .limit(1);
  if (!row) throw new MarketplaceError("not_found", "No such publisher");
  return toPublisher(row);
}

/** The caller's role in a publisher, or null when not a member. */
export async function getMembershipRole(
  deps: MarketplaceDeps,
  publisherId: string,
  userId: string,
): Promise<PublisherRole | null> {
  const [row] = await deps.db
    .select({ role: member.role })
    .from(member)
    .innerJoin(publishers, eq(publishers.organizationId, member.organizationId))
    .where(and(eq(publishers.id, publisherId), eq(member.userId, userId)))
    .limit(1);
  return row ? toRole(row.role) : null;
}

/**
 * Loads a publisher and checks the caller may act on it. Members may read; owners and admins may manage.
 * Marketplace admins (`admin` scope) may do both. Non-members get `not_found`, so membership is not disclosed.
 */
export async function authorizePublisher(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
  need: "read" | "manage",
): Promise<{ publisher: PublisherRow; role: PublisherRole | null }> {
  requireScope(actor, need === "manage" ? "publishers:write" : "publishers:read");
  const userId = requireUser(actor);
  const [publisher] = await deps.db.select().from(publishers).where(eq(publishers.id, publisherId)).limit(1);
  const role = publisher ? await getMembershipRole(deps, publisher.id, userId) : null;
  const isAdmin = actorHasScope(actor, "admin");
  if (!publisher || (role === null && !isAdmin)) throw new MarketplaceError("not_found", "No such publisher");
  if (need === "manage" && !isAdmin && (role === null || !MANAGER_ROLES.includes(role))) {
    throw new MarketplaceError("forbidden", "Only publisher owners and admins can do this");
  }
  return { publisher, role };
}

export async function listPublisherMembers(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
): Promise<PublisherMember[]> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "read");
  if (publisher.organizationId === null) return [];
  const rows = await deps.db
    .select({ userId: member.userId, role: member.role, joinedAt: member.createdAt, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, publisher.organizationId))
    .orderBy(asc(member.createdAt));
  return rows.map((row) => ({ ...row, role: toRole(row.role), joinedAt: row.joinedAt.toISOString() }));
}

export async function listPublisherInvitations(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
): Promise<PublisherInvitation[]> {
  const { publisher } = await authorizePublisher(deps, actor, publisherId, "manage");
  if (publisher.organizationId === null) return [];
  const rows = await deps.db
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, publisher.organizationId), eq(invitation.status, "pending")))
    .orderBy(asc(invitation.createdAt));
  return rows.map((row) => toInvitation(row, publisher.id));
}

/**
 * Invites an email address. No email is sent (the platform has no mail transport yet): the inviter shares the
 * invitation id/link, and only a signed-in account with that email can accept it. Only owners may invite admins.
 */
export async function inviteMember(
  deps: MarketplaceDeps,
  actor: Actor,
  publisherId: string,
  input: InviteMemberInput,
): Promise<PublisherInvitation> {
  const { publisher, role } = await authorizePublisher(deps, actor, publisherId, "manage");
  const { email, role: inviteRole } = parseInput(inviteMemberInputSchema, input);
  if (inviteRole === "admin" && role !== "owner" && !actorHasScope(actor, "admin")) {
    throw new MarketplaceError("forbidden", "Only owners can invite admins");
  }
  const organizationId = requireOrganization(publisher);

  const [existingMember] = await deps.db
    .select({ id: member.id })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, organizationId), eq(user.email, email)))
    .limit(1);
  if (existingMember) throw new MarketplaceError("conflict", "That account is already a member");

  const now = deps.now();
  const pending = await deps.db
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, organizationId), eq(invitation.email, email), eq(invitation.status, "pending")));
  const live = pending.find((row) => row.expiresAt > now);
  if (live) return toInvitation(live, publisher.id);

  const row: typeof invitation.$inferSelect = {
    id: deps.ids("inv"),
    organizationId,
    email,
    role: inviteRole,
    status: "pending",
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    createdAt: now,
    inviterId: requireUser(actor),
  };
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "publisher.member_invited",
    subject: { type: "publisher", id: publisher.id },
    data: { invitationId: row.id, role: inviteRole },
  });
  await deps.db.batch([deps.db.insert(invitation).values(row), audit.statement]);
  return toInvitation(row, publisher.id);
}

/** Accepts an invitation addressed to the caller's account email. */
export async function acceptInvitation(
  deps: MarketplaceDeps,
  actor: Actor,
  invitationId: string,
): Promise<Publisher> {
  requireScope(actor, "account:write");
  const userId = requireUser(actor);
  const [row] = await deps.db
    .select({ invitation, publisher: publishers })
    .from(invitation)
    .innerJoin(publishers, eq(publishers.organizationId, invitation.organizationId))
    .where(eq(invitation.id, invitationId))
    .limit(1);
  const [account] = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  // Same answer for "no such invitation" and "addressed to someone else", so ids cannot be probed.
  if (!row || !account || row.invitation.email !== account.email.toLowerCase()) {
    throw new MarketplaceError("not_found", "No such invitation for this account");
  }
  if (row.invitation.status !== "pending" || row.invitation.expiresAt <= deps.now()) {
    throw new MarketplaceError("conflict", "This invitation is no longer valid");
  }
  if ((await getMembershipRole(deps, row.publisher.id, userId)) !== null) {
    throw new MarketplaceError("conflict", "You are already a member");
  }

  const role = publisherRoleSchema.exclude(["owner"]).catch("member").parse(row.invitation.role);
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "publisher.member_joined",
    subject: { type: "publisher", id: row.publisher.id },
    data: { invitationId, role },
  });
  await deps.db.batch([
    deps.db
      .insert(member)
      .values({ id: deps.ids("mem"), organizationId: row.invitation.organizationId, userId, role, createdAt: deps.now() }),
    deps.db.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, invitationId)),
    audit.statement,
  ]);
  return { ...toPublisher(row.publisher), role };
}

/** Publisher ids the user belongs to; used by account export/deletion and "my packages". */
export async function listMembershipPublisherIds(deps: MarketplaceDeps, userId: string): Promise<string[]> {
  const rows = await deps.db
    .select({ id: publishers.id })
    .from(member)
    .innerJoin(publishers, eq(publishers.organizationId, member.organizationId))
    .where(eq(member.userId, userId));
  return rows.map((row) => row.id);
}

export async function countMembers(deps: MarketplaceDeps, organizationIds: string[]) {
  if (organizationIds.length === 0) return [];
  return deps.db
    .select({ organizationId: member.organizationId, userId: member.userId, role: member.role })
    .from(member)
    .where(inArray(member.organizationId, organizationIds));
}

export function requireOrganization(publisher: PublisherRow): string {
  if (publisher.organizationId === null) {
    throw new MarketplaceError("conflict", "This publisher has no member organization; ask a marketplace admin");
  }
  return publisher.organizationId;
}

export function toRole(role: string): PublisherRole {
  return publisherRoleSchema.catch("member").parse(role);
}

export function toPublisher(row: PublisherRow): Publisher {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toInvitation(row: typeof invitation.$inferSelect, publisherId: string): PublisherInvitation {
  return {
    id: row.id,
    publisherId,
    email: row.email,
    role: toRole(row.role ?? "member"),
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
  };
}
