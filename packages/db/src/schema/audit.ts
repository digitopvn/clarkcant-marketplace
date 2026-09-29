import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createdAt } from "./columns";

export const ACTOR_TYPES = ["user", "token", "system"] as const;

/** Append-only record of every state-changing command. Rows are never updated or deleted by application code. */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type", { enum: ACTOR_TYPES }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),
    idempotencyKey: text("idempotency_key"),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_events_subject_idx").on(table.subjectType, table.subjectId, table.createdAt),
    index("audit_events_actor_idx").on(table.actorType, table.actorId, table.createdAt),
    index("audit_events_action_idx").on(table.action, table.createdAt),
  ],
);

/**
 * Idempotency keys scoped per caller/operation. A row with a null `status_code` is an in-flight reservation; a row
 * with a status code is the stored response that a retry with the same request hash replays.
 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    requestHash: text("request_hash").notNull(),
    response: text("response", { mode: "json" }).$type<unknown>(),
    statusCode: integer("status_code"),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] }), index("idempotency_keys_created_idx").on(table.createdAt)],
);
