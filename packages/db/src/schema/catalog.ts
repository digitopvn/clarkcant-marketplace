import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { createdAt, updatedAt } from "./columns";
import { packages } from "./packages";

export const categories = sqliteTable(
  "categories",
  {
    slug: text("slug").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    position: integer("position").notNull().default(0),
  },
  (table) => [index("categories_position_idx").on(table.position)],
);

/** Editorially curated, ordered lists of packages. */
export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    published: integer("published", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("collections_slug_uidx").on(table.slug),
    index("collections_published_idx").on(table.published, table.position),
  ],
);

export const collectionItems = sqliteTable(
  "collection_items",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    note: text("note"),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.packageId] }),
    index("collection_items_order_idx").on(table.collectionId, table.position),
  ],
);
