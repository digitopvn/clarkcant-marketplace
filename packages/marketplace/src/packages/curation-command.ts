import { requireScope, requireUser, type Actor } from "@marketplace/contracts";

import type { MarketplaceDeps } from "../deps";
import { withIdempotency } from "../idempotency/idempotency-store";

export interface CurationCommandOptions {
  /** `Idempotency-Key` from the caller; a retry with the same key and input replays the first result. */
  idempotencyKey?: string;
}

/**
 * Shared frame for curation commands (`packages:curate`): authorize, then run once per idempotency key. The
 * command itself writes its change and audit event in one D1 batch.
 */
export async function runCurationCommand<T>(
  deps: MarketplaceDeps,
  actor: Actor,
  operation: string,
  request: unknown,
  options: CurationCommandOptions,
  execute: () => Promise<T>,
): Promise<T> {
  requireScope(actor, "packages:curate");
  const userId = requireUser(actor);
  if (!options.idempotencyKey) return execute();
  const outcome = await withIdempotency(
    deps,
    { scope: `user:${userId}:${operation}`, key: options.idempotencyKey },
    request,
    async () => ({ statusCode: 200, response: await execute() }),
  );
  return outcome.response;
}
