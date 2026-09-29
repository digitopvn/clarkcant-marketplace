import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { user } from "./auth";
import { createdAt } from "./columns";

/**
 * Content-addressed media stored in R2 under `sha256/ab/cd/<digest>.<ext>`. The digest is the identity, so the same
 * bytes uploaded twice resolve to one object.
 */
export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    sha256: text("sha256").notNull(),
    r2Key: text("r2_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("media_sha256_uidx").on(table.sha256),
    uniqueIndex("media_r2_key_uidx").on(table.r2Key),
    index("media_owner_idx").on(table.ownerUserId),
  ],
);
