import {
  MarketplaceError,
  linkDeviceInputSchema,
  requireScope,
  requireUser,
  toAuditActor,
  type Actor,
  type DeviceLink,
  type LinkDeviceInput,
} from "@marketplace/contracts";
import { clarkcantDeviceLinks } from "@marketplace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";

type DeviceLinkRow = typeof clarkcantDeviceLinks.$inferSelect;

/**
 * Records that a ClarkCant install (identified by its local principal `prin_*`) belongs to this marketplace
 * account. The link is informational and optional: ClarkCant's local identity stays authoritative on the device,
 * and a link never grants the marketplace any runtime authority there.
 *
 * Linking the same principal again refreshes its label and re-activates a previously unlinked row, so a client
 * retrying after a network failure does not create duplicates.
 */
export async function linkDevice(deps: MarketplaceDeps, actor: Actor, input: LinkDeviceInput): Promise<DeviceLink> {
  requireScope(actor, "account:write");
  const userId = requireUser(actor);
  const { localPrincipalId, deviceLabel } = parseInput(linkDeviceInputSchema, input);

  const [existing] = await deps.db
    .select()
    .from(clarkcantDeviceLinks)
    .where(and(eq(clarkcantDeviceLinks.userId, userId), eq(clarkcantDeviceLinks.localPrincipalId, localPrincipalId)))
    .limit(1);

  const now = deps.now();
  const row: DeviceLinkRow = existing
    ? { ...existing, deviceLabel, revokedAt: null, createdAt: existing.revokedAt === null ? existing.createdAt : now }
    : { id: deps.ids("dev"), userId, localPrincipalId, deviceLabel, createdAt: now, revokedAt: null };

  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "device_link.linked",
    subject: { type: "device_link", id: row.id },
    data: { localPrincipalId, deviceLabel, via: actor.tokenId ?? "session" },
  });
  const write = existing
    ? deps.db
        .update(clarkcantDeviceLinks)
        .set({ deviceLabel, revokedAt: null, createdAt: row.createdAt })
        .where(eq(clarkcantDeviceLinks.id, existing.id))
    : deps.db.insert(clarkcantDeviceLinks).values(row);
  await deps.db.batch([write, audit.statement]);
  return toDeviceLink(row);
}

export async function listDeviceLinks(deps: MarketplaceDeps, actor: Actor): Promise<DeviceLink[]> {
  requireScope(actor, "account:read");
  const rows = await deps.db
    .select()
    .from(clarkcantDeviceLinks)
    .where(and(eq(clarkcantDeviceLinks.userId, requireUser(actor)), isNull(clarkcantDeviceLinks.revokedAt)))
    .orderBy(desc(clarkcantDeviceLinks.createdAt), desc(clarkcantDeviceLinks.id));
  return rows.map(toDeviceLink);
}

/** Unlinks one of the caller's devices. The row is kept (revoked) for the account's own export and audit trail. */
export async function unlinkDevice(deps: MarketplaceDeps, actor: Actor, linkId: string): Promise<void> {
  requireScope(actor, "account:write");
  const userId = requireUser(actor);
  const [row] = await deps.db
    .select()
    .from(clarkcantDeviceLinks)
    .where(and(eq(clarkcantDeviceLinks.id, linkId), eq(clarkcantDeviceLinks.userId, userId)))
    .limit(1);
  if (!row || row.revokedAt !== null) throw new MarketplaceError("not_found", "No such linked device");

  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "device_link.unlinked",
    subject: { type: "device_link", id: row.id },
    data: { localPrincipalId: row.localPrincipalId },
  });
  await deps.db.batch([
    deps.db.update(clarkcantDeviceLinks).set({ revokedAt: deps.now() }).where(eq(clarkcantDeviceLinks.id, row.id)),
    audit.statement,
  ]);
}

export function toDeviceLink(row: DeviceLinkRow): DeviceLink {
  return {
    id: row.id,
    localPrincipalId: row.localPrincipalId,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt.toISOString(),
  };
}
