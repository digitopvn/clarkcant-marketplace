import { sql } from "drizzle-orm";
import { integer } from "drizzle-orm/sqlite-core";

/** Millisecond epoch default, identical to the one Better Auth generates, so every table shares one clock format. */
const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull();
export const updatedAt = () => integer("updated_at", { mode: "timestamp_ms" }).default(nowMs).notNull();
export const timestampMs = (name: string) => integer(name, { mode: "timestamp_ms" });
