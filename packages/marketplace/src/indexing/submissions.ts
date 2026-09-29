import {
  MarketplaceError,
  actorHasScope,
  requireScope,
  requireUser,
  submitPackageInputSchema,
  toAuditActor,
  type Actor,
  type AuditActor,
  type IngestMessage,
  type Submission,
} from "@marketplace/contracts";
import { packageSubmissions } from "@marketplace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { withIdempotency } from "../idempotency/idempotency-store";
import { parseInput } from "../validation";

type SubmissionRow = typeof packageSubmissions.$inferSelect;

export const submissionIdSchema = z.string().regex(/^sub_[0-9a-z]{26}$/, { error: "must be a submission id" });

export interface SubmitPackageOptions {
  /** `Idempotency-Key` from the caller; a retry with the same key and body replays the first answer. */
  idempotencyKey?: string;
  /**
   * Put the submission on the ingest queue (default). `false` only records it, for callers that run `indexPackage`
   * themselves (tests, the local CLI path).
   */
  enqueue?: boolean;
}

export interface SubmitPackageResult {
  submission: Submission;
  /** False when an identical open submission already existed and was returned instead. */
  created: boolean;
}

export function toSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    packageName: row.packageName,
    version: row.version,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Sends an index request to the ingest queue; a missing binding is a deployment error, not a silent no-op. */
export async function enqueueIngest(deps: MarketplaceDeps, message: IngestMessage): Promise<void> {
  if (!deps.queue) throw new MarketplaceError("configuration_error", "the INGEST_QUEUE binding is not configured");
  await deps.queue.send(message);
}

/**
 * Asks the marketplace to index an npm package version (`packages:submit`). Idempotent twice over: an open
 * submission for the same name and version is returned rather than duplicated, and an `Idempotency-Key` replays
 * the original response.
 */
export async function submitPackage(
  deps: MarketplaceDeps,
  actor: Actor,
  rawInput: unknown,
  options: SubmitPackageOptions = {},
): Promise<SubmitPackageResult> {
  requireScope(actor, "packages:submit");
  const userId = requireUser(actor);
  const input = parseInput(submitPackageInputSchema, rawInput);

  const execute = async () => ({ statusCode: 202, response: await createSubmission(deps, actor, userId, input, options) });
  if (!options.idempotencyKey) return (await execute()).response;
  const outcome = await withIdempotency(
    deps,
    { scope: `user:${userId}:packages.submit`, key: options.idempotencyKey },
    input,
    execute,
  );
  return outcome.response;
}

async function createSubmission(
  deps: MarketplaceDeps,
  actor: Actor,
  userId: string,
  input: { name: string; version?: string | undefined },
  options: SubmitPackageOptions,
): Promise<SubmitPackageResult> {
  const version = input.version ?? null;
  const [open] = await deps.db
    .select()
    .from(packageSubmissions)
    .where(
      and(
        eq(packageSubmissions.packageName, input.name),
        version === null ? isNull(packageSubmissions.version) : eq(packageSubmissions.version, version),
        inArray(packageSubmissions.status, ["queued", "indexing"]),
      ),
    )
    .orderBy(desc(packageSubmissions.createdAt))
    .limit(1);
  if (open) return { submission: toSubmission(open), created: false };

  const now = deps.now();
  const row: SubmissionRow = {
    id: deps.ids("sub"),
    packageName: input.name,
    version,
    submittedBy: userId,
    status: "queued",
    error: null,
    workflowId: null,
    createdAt: now,
    updatedAt: now,
  };
  const audit = prepareAuditEvent(deps, {
    actor: toAuditActor(actor),
    action: "package.submitted",
    subject: { type: "package_submission", id: row.id },
    data: { name: input.name, version },
  });
  await deps.db.batch([deps.db.insert(packageSubmissions).values(row), audit.statement]);

  if (options.enqueue !== false) {
    try {
      await enqueueIngest(deps, { type: "index-package", submissionId: row.id, packageName: input.name });
    } catch (error) {
      // Never leave a submission "queued" when nothing will ever pick it up.
      await deps.db
        .update(packageSubmissions)
        .set({ status: "failed", error: "could not be queued for indexing", updatedAt: deps.now() })
        .where(eq(packageSubmissions.id, row.id));
      throw error;
    }
  }
  return { submission: toSubmission(row), created: true };
}

/**
 * Records a submission made by the system rather than an account (npm discovery, the local `index:local` CLI):
 * the submission row and its audit event in one batch. The caller decides whether to queue or index it.
 */
export async function createSystemSubmission(
  deps: MarketplaceDeps,
  input: { name: string; version: string | null; actor: AuditActor; action: string; source: string },
): Promise<string> {
  const now = deps.now();
  const id = deps.ids("sub");
  const audit = prepareAuditEvent(deps, {
    actor: input.actor,
    action: input.action,
    subject: { type: "package_submission", id },
    data: { name: input.name, version: input.version, source: input.source },
  });
  await deps.db.batch([
    deps.db.insert(packageSubmissions).values({
      id,
      packageName: input.name,
      version: input.version,
      submittedBy: null,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    }),
    audit.statement,
  ]);
  return id;
}

/** A submission is visible to the account that made it and to curators; to anyone else it does not exist. */
export async function getSubmission(deps: MarketplaceDeps, actor: Actor, rawId: unknown): Promise<Submission> {
  const userId = requireUser(actor);
  const id = parseInput(submissionIdSchema, rawId);
  const [row] = await deps.db.select().from(packageSubmissions).where(eq(packageSubmissions.id, id)).limit(1);
  if (!row || (row.submittedBy !== userId && !actorHasScope(actor, "packages:curate"))) {
    throw new MarketplaceError("not_found", `submission "${id}" was not found`);
  }
  return toSubmission(row);
}
