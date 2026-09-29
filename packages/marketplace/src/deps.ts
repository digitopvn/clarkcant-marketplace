import type { IngestMessage } from "@marketplace/contracts";
import { createDb, type Database } from "@marketplace/db";

/**
 * Everything an application service may touch. Interfaces (web, API, MCP, CLI, jobs) build one per request or per
 * job invocation and pass it in; services never reach for globals, so the same code runs in every Worker and in
 * tests against a real D1.
 */
export interface MarketplaceDeps {
  db: Database;
  /** Producer for the ingest queue. Absent where the caller has no queue binding (e.g. read-only surfaces). */
  queue?: Queue<IngestMessage> | undefined;
  /** R2 bucket for content-addressed media. */
  media?: R2Bucket | undefined;
  now(): Date;
  /** Returns a new unique id carrying `prefix`, e.g. `ids("pkg")` → `pkg_01j…`. */
  ids(prefix: string): string;
}

export interface MarketplaceBindings {
  d1: D1Database;
  queue?: Queue<IngestMessage> | undefined;
  media?: R2Bucket | undefined;
}

export function createMarketplaceDeps(bindings: MarketplaceBindings): MarketplaceDeps {
  return {
    db: createDb(bindings.d1),
    queue: bindings.queue,
    media: bindings.media,
    now: () => new Date(),
    ids: createId,
  };
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Time-ordered id: 10 base32 chars of millisecond time followed by 16 random base32 chars (80 bits), so ids sort by
 * creation time and never collide in practice. Uses Web Crypto, available in Workers and Node.
 */
export function createId(prefix: string, now: number = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD.charAt(remaining % 32) + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (const byte of bytes) random += CROCKFORD.charAt(byte % 32);
  return `${prefix}_${time}${random}`;
}
