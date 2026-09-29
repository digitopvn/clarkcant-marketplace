import {
  IDEMPOTENCY_TTL_MS,
  MarketplaceError,
  idempotencyKeySchema,
  type IdempotencyBegin,
} from "@marketplace/contracts";
import { idempotencyKeys } from "@marketplace/db";
import { and, eq, isNull } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";
import { parseInput } from "../validation";

/**
 * How long an unfinished reservation blocks retries. A Worker that died mid-command never completes or releases
 * its reservation, so after this lease a retry may take the key over instead of waiting for the full TTL.
 */
export const IDEMPOTENCY_LEASE_MS = 60 * 1000;

export interface IdempotencyRef {
  /** Who and what the key belongs to, e.g. `user:<id>:packages.submit`. Keys never collide across scopes. */
  scope: string;
  key: string;
}

/** SHA-256 over a canonical JSON rendering of the request, so a reused key with a different body is detected. */
export async function hashRequest(request: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reserves `(scope, key)` for a request, or reports what already happened under it. Uses insert-or-nothing so two
 * concurrent callers can never both see `new`.
 */
export async function beginIdempotentRequest(
  deps: MarketplaceDeps,
  ref: IdempotencyRef,
  requestHash: string,
): Promise<IdempotencyBegin> {
  const key = parseInput(idempotencyKeySchema, ref.key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inserted = await deps.db
      .insert(idempotencyKeys)
      .values({ scope: ref.scope, key, requestHash, createdAt: deps.now() })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length > 0) return { state: "new" };

    const [existing] = await deps.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!existing) continue; // Deleted between our insert and read; try once more.

    const age = deps.now().getTime() - existing.createdAt.getTime();
    const abandoned = existing.statusCode === null && age > IDEMPOTENCY_LEASE_MS;
    if (age > IDEMPOTENCY_TTL_MS || abandoned) {
      // Compare-and-delete on created_at so only one caller reclaims a stale row.
      await deps.db
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.scope, ref.scope),
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.createdAt, existing.createdAt),
          ),
        );
      continue;
    }
    if (existing.requestHash !== requestHash) return { state: "mismatch" };
    if (existing.statusCode === null) return { state: "in_progress" };
    return { state: "replay", statusCode: existing.statusCode, response: existing.response };
  }
  return { state: "in_progress" };
}

/** Stores the outcome so retries replay it. Only the reservation holder (status still null) may complete. */
export async function completeIdempotentRequest(
  deps: MarketplaceDeps,
  ref: IdempotencyRef,
  outcome: { statusCode: number; response: unknown },
): Promise<void> {
  await deps.db
    .update(idempotencyKeys)
    .set({ statusCode: outcome.statusCode, response: outcome.response ?? null })
    .where(
      and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, ref.key), isNull(idempotencyKeys.statusCode)),
    );
}

/** Drops an unfinished reservation after a failure so the client can retry immediately with the same key. */
export async function releaseIdempotentRequest(deps: MarketplaceDeps, ref: IdempotencyRef): Promise<void> {
  await deps.db
    .delete(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, ref.key), isNull(idempotencyKeys.statusCode)),
    );
}

/**
 * Runs `execute` at most once per `(scope, key, request)`. A retry with the same request replays the stored result;
 * the same key with a different request, or while the first is still running, is rejected. Failures release the
 * key so they are not replayed.
 */
export async function withIdempotency<T>(
  deps: MarketplaceDeps,
  ref: IdempotencyRef,
  request: unknown,
  execute: () => Promise<{ statusCode: number; response: T }>,
): Promise<{ statusCode: number; response: T; replayed: boolean }> {
  const begin = await beginIdempotentRequest(deps, ref, await hashRequest(request));
  switch (begin.state) {
    case "replay":
      // The stored response was produced by this same operation for this same request hash.
      return { statusCode: begin.statusCode, response: begin.response as T, replayed: true };
    case "mismatch":
      throw new MarketplaceError("idempotency_key_reused", "this Idempotency-Key was already used for a different request");
    case "in_progress":
      throw new MarketplaceError("idempotency_in_progress", "a request with this Idempotency-Key is still in progress");
    case "new":
      break;
  }
  try {
    const outcome = await execute();
    await completeIdempotentRequest(deps, ref, outcome);
    return { ...outcome, replayed: false };
  } catch (error) {
    await releaseIdempotentRequest(deps, ref).catch((releaseError: unknown) => {
      console.error("idempotency: failed to release reservation", releaseError);
    });
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
