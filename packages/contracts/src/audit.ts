import { z } from "zod";

export const actorTypeSchema = z.enum(["user", "token", "system"]);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const auditActorSchema = z.object({
  type: actorTypeSchema,
  /** User id, API token id, or a system component name such as `jobs.indexer`. */
  id: z.string().min(1).max(200).nullable(),
});
export type AuditActor = z.infer<typeof auditActorSchema>;

/** `<subject>.<verb>` in lowercase, e.g. `package.submitted`, `page.published`. */
export const auditActionSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, { error: "must look like subject.verb" });

export const auditEventInputSchema = z.object({
  actor: auditActorSchema,
  action: auditActionSchema,
  subject: z.object({
    type: z.string().min(1).max(64),
    id: z.string().min(1).max(200).nullable(),
  }),
  idempotencyKey: z.string().min(1).max(255).optional(),
  /** Context for the event. Callers must not put secrets or token plaintext here. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEventInput = z.input<typeof auditEventInputSchema>;

export const auditEventSchema = z.object({
  id: z.string(),
  actor: auditActorSchema,
  action: z.string(),
  subject: z.object({ type: z.string(), id: z.string().nullable() }),
  idempotencyKey: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
