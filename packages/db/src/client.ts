import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import * as schema from "./schema";

export type Database = DrizzleD1Database<typeof schema>;

/**
 * Wraps a D1 binding. Call once per request (or per queue batch/workflow step): the binding belongs to the current
 * invocation, so a module-level singleton would capture a stale one.
 */
export function createDb(d1: D1Database): Database {
  return drizzle(d1, { schema });
}
