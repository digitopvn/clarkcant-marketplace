import { auditEventInputSchema, type AuditEvent, type AuditEventInput } from "@marketplace/contracts";
import { auditEvents } from "@marketplace/db";
import { and, desc, eq } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";

type AuditRow = typeof auditEvents.$inferSelect;

/**
 * Prepares an audit insert without running it, so a command can put it in the same `db.batch([...])` as its own
 * writes. D1 runs a batch atomically: the change and its audit record land together or not at all.
 */
export function prepareAuditEvent(deps: MarketplaceDeps, input: AuditEventInput) {
  const event = parseInput(auditEventInputSchema, input);
  const row: AuditRow = {
    id: deps.ids("aud"),
    actorType: event.actor.type,
    actorId: event.actor.id,
    action: event.action,
    subjectType: event.subject.type,
    subjectId: event.subject.id,
    idempotencyKey: event.idempotencyKey ?? null,
    data: event.data ?? null,
    createdAt: deps.now(),
  };
  return { event: toAuditEvent(row), statement: deps.db.insert(auditEvents).values(row) };
}

/** Records one audit event on its own. Prefer `prepareAuditEvent` inside a batch when a command also writes. */
export async function recordAuditEvent(deps: MarketplaceDeps, input: AuditEventInput): Promise<AuditEvent> {
  const { event, statement } = prepareAuditEvent(deps, input);
  await statement;
  return event;
}

export async function listAuditEventsForSubject(
  deps: MarketplaceDeps,
  subject: { type: string; id: string },
  limit = 50,
): Promise<AuditEvent[]> {
  const rows = await deps.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.subjectType, subject.type), eq(auditEvents.subjectId, subject.id)))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(toAuditEvent);
}

function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actor: { type: row.actorType, id: row.actorId },
    action: row.action,
    subject: { type: row.subjectType, id: row.subjectId },
    idempotencyKey: row.idempotencyKey,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}
