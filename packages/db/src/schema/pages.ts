import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { user } from "./auth";
import { createdAt, updatedAt } from "./columns";

export const PAGE_KINDS = ["custom", "legal", "docs", "landing", "category", "collection"] as const;

/** Versioned layout definitions a page document refers to by `(id, version)`. */
export const layouts = sqliteTable(
  "layouts",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    definition: text("definition", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("layouts_id_version_uidx").on(table.id, table.version)],
);

/**
 * A page points at two revisions: the draft being edited and the one the public sees. Publishing moves a pointer;
 * it never rewrites a revision.
 */
export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    kind: text("kind", { enum: PAGE_KINDS }).notNull(),
    title: text("title").notNull(),
    currentDraftRevisionId: text("current_draft_revision_id").references((): AnySQLiteColumn => pageRevisions.id, {
      onDelete: "set null",
    }),
    publishedRevisionId: text("published_revision_id").references((): AnySQLiteColumn => pageRevisions.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("pages_slug_uidx").on(table.slug), index("pages_kind_idx").on(table.kind)],
);

/** Immutable: every save appends a revision numbered per page. */
export const pageRevisions = sqliteTable(
  "page_revisions",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references((): AnySQLiteColumn => pages.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    document: text("document", { mode: "json" }).$type<unknown>().notNull(),
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    parentRevisionId: text("parent_revision_id"),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("page_revisions_page_number_uidx").on(table.pageId, table.number)],
);

export const pagePublications = sqliteTable(
  "page_publications",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => pageRevisions.id, { onDelete: "restrict" }),
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
    publishedAt: createdAt(),
    action: text("action", { enum: ["publish", "rollback"] }).notNull(),
  },
  (table) => [index("page_publications_page_idx").on(table.pageId, table.publishedAt)],
);
