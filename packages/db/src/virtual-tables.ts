import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Query-builder view of the FTS5 virtual table created by `migrations/0001_packages_fts.sql`.
 *
 * It lives outside `schema/` on purpose: drizzle-kit only reads `schema/index.ts`, so it never tries to generate a
 * plain `CREATE TABLE` for it. Declaring it lets services write to the index inside `db.batch([...])` with typed
 * columns; `MATCH` and `bm25()` are still expressed with `sql`.
 */
export const packagesFts = sqliteTable("packages_fts", {
  packageId: text("package_id").notNull(),
  name: text("name").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull(),
  keywords: text("keywords").notNull(),
  publisher: text("publisher").notNull(),
  facets: text("facets").notNull(),
});
