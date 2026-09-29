import {
  MarketplaceError,
  collectionCommandSchema,
  requireScope,
  slugSchema,
  toAuditActor,
  type Actor,
  type CollectionCommand,
  type CollectionCommandInput,
  type CollectionState,
} from "@marketplace/contracts";
import { collectionItems, collections, packages } from "@marketplace/db";
import { and, asc, eq, max } from "drizzle-orm";

import { prepareAuditEvent } from "../audit/audit-writer";
import type { MarketplaceDeps } from "../deps";
import { runCurationCommand, type CurationCommandOptions } from "../packages/curation-command";
import { findPackageForCuration } from "../packages/curation-commands";
import { parseInput } from "../validation";

type CollectionRow = typeof collections.$inferSelect;

async function findCollection(deps: MarketplaceDeps, slug: string): Promise<CollectionRow | undefined> {
  const [row] = await deps.db.select().from(collections).where(eq(collections.slug, slug)).limit(1);
  return row;
}

async function requireCollection(deps: MarketplaceDeps, slug: string): Promise<CollectionRow> {
  const row = await findCollection(deps, slug);
  if (!row) throw new MarketplaceError("not_found", `collection "${slug}" was not found`);
  return row;
}

async function loadState(deps: MarketplaceDeps, row: CollectionRow): Promise<CollectionState> {
  const items = await deps.db
    .select({ packageName: packages.name, position: collectionItems.position, note: collectionItems.note })
    .from(collectionItems)
    .innerJoin(packages, eq(packages.id, collectionItems.packageId))
    .where(eq(collectionItems.collectionId, row.id))
    .orderBy(asc(collectionItems.position), asc(packages.name));
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    published: row.published,
    position: row.position,
    items,
  };
}

/** Curator view of a collection, published or not, with every item whatever its package's curation status. */
export async function getCollectionState(deps: MarketplaceDeps, actor: Actor, rawSlug: unknown): Promise<CollectionState> {
  requireScope(actor, "packages:curate");
  const slug = parseInput(slugSchema, rawSlug);
  return loadState(deps, await requireCollection(deps, slug));
}

/**
 * `manage_collection`: create, update, add/remove items and reorder. Each command writes its change and its audit
 * event in one atomic batch and returns the resulting collection state.
 */
export async function manageCollection(
  deps: MarketplaceDeps,
  actor: Actor,
  rawSlug: unknown,
  rawCommand: CollectionCommandInput | unknown,
  options: CurationCommandOptions = {},
): Promise<CollectionState> {
  const slug = parseInput(slugSchema, rawSlug);
  const command = parseInput(collectionCommandSchema, rawCommand);
  return runCurationCommand(deps, actor, `collections.${command.action}`, { slug, command }, options, () =>
    executeCommand(deps, actor, slug, command, options.idempotencyKey),
  );
}

async function executeCommand(
  deps: MarketplaceDeps,
  actor: Actor,
  slug: string,
  command: CollectionCommand,
  idempotencyKey: string | undefined,
): Promise<CollectionState> {
  const now = deps.now();
  const audit = (collectionId: string, data: Record<string, unknown>) =>
    prepareAuditEvent(deps, {
      actor: toAuditActor(actor),
      action: `collection.${command.action}`,
      subject: { type: "collection", id: collectionId },
      ...(idempotencyKey ? { idempotencyKey } : {}),
      data: { slug, ...data },
    }).statement;

  switch (command.action) {
    case "create": {
      if (await findCollection(deps, slug)) throw new MarketplaceError("conflict", `collection "${slug}" already exists`);
      const id = deps.ids("col");
      const { action: _action, ...fields } = command;
      await deps.db.batch([
        deps.db.insert(collections).values({ id, slug, ...fields, createdAt: now, updatedAt: now }),
        audit(id, fields),
      ]);
      break;
    }
    case "update": {
      const row = await requireCollection(deps, slug);
      const { action: _action, ...changes } = command;
      const fields = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      await deps.db.batch([
        deps.db.update(collections).set({ ...fields, updatedAt: now }).where(eq(collections.id, row.id)),
        audit(row.id, fields),
      ]);
      break;
    }
    case "add_item": {
      const row = await requireCollection(deps, slug);
      const pkg = await findPackageForCuration(deps, command.packageName);
      const [last] = await deps.db
        .select({ position: max(collectionItems.position) })
        .from(collectionItems)
        .where(eq(collectionItems.collectionId, row.id));
      await deps.db.batch([
        deps.db
          .insert(collectionItems)
          .values({ collectionId: row.id, packageId: pkg.id, position: (last?.position ?? -1) + 1, note: command.note ?? null })
          // Adding an item that is already present only updates its note; its position is kept.
          .onConflictDoUpdate({
            target: [collectionItems.collectionId, collectionItems.packageId],
            set: { note: command.note ?? null },
          }),
        deps.db.update(collections).set({ updatedAt: now }).where(eq(collections.id, row.id)),
        audit(row.id, { packageName: pkg.name }),
      ]);
      break;
    }
    case "remove_item": {
      const row = await requireCollection(deps, slug);
      const pkg = await findPackageForCuration(deps, command.packageName);
      await deps.db.batch([
        deps.db
          .delete(collectionItems)
          .where(and(eq(collectionItems.collectionId, row.id), eq(collectionItems.packageId, pkg.id))),
        deps.db.update(collections).set({ updatedAt: now }).where(eq(collections.id, row.id)),
        audit(row.id, { packageName: pkg.name }),
      ]);
      break;
    }
    case "reorder": {
      const row = await requireCollection(deps, slug);
      const current = await loadState(deps, row);
      const expected = new Set(current.items.map((item) => item.packageName));
      const requested = new Set(command.packageNames);
      const sameSet =
        requested.size === command.packageNames.length &&
        requested.size === expected.size &&
        [...requested].every((name) => expected.has(name));
      if (!sameSet) {
        throw new MarketplaceError("validation_failed", "reorder must list every item in the collection exactly once", {
          details: { expected: [...expected].sort() },
        });
      }
      const ids = new Map(
        (
          await deps.db
            .select({ id: packages.id, name: packages.name })
            .from(collectionItems)
            .innerJoin(packages, eq(packages.id, collectionItems.packageId))
            .where(eq(collectionItems.collectionId, row.id))
        ).map((entry) => [entry.name, entry.id]),
      );
      const updates = command.packageNames.map((name, position) =>
        deps.db
          .update(collectionItems)
          .set({ position })
          .where(and(eq(collectionItems.collectionId, row.id), eq(collectionItems.packageId, ids.get(name) ?? ""))),
      );
      await deps.db.batch([
        deps.db.update(collections).set({ updatedAt: now }).where(eq(collections.id, row.id)),
        ...updates,
        audit(row.id, { order: command.packageNames }),
      ]);
      break;
    }
  }
  return loadState(deps, await requireCollection(deps, slug));
}
