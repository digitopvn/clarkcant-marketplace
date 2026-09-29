import { blockNodeSchema, blockTypeSchema, type BlockNode, type PageDocument } from "@marketplace/contracts";
import { z } from "zod";

/*
 * Page operations: the edit primitives shared by the builder, the admin API, MCP and WebMCP. They address blocks by
 * stable id (never by array position alone), are pure (document in, new document out) and import nothing
 * server-only, so the builder applies exactly the same logic locally that the server applies on save. The result
 * still has to pass `validatePageDocument`; operations only check structure.
 */

const blockId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

/**
 * Where a block goes: before/after a sibling, else at the end of `parentId`'s children. `parentId: null` means the
 * page root; when `parentId` is absent the anchor sibling's list is used (or the root without an anchor).
 */
const placement = {
  parentId: blockId.nullable().optional(),
  beforeId: blockId.optional(),
  afterId: blockId.optional(),
};

export const addBlockOpSchema = z.object({
  op: z.literal("add_block"),
  block: z.object({
    /** Optional client-chosen id; generated when absent and returned in the result. */
    id: blockId.optional(),
    type: blockTypeSchema,
    /** Defaults to the latest registered version. */
    version: z.int().positive().optional(),
    /** Defaults to the block's default props; given props are merged over them. */
    props: z.record(z.string(), z.unknown()).optional(),
    children: z.array(blockNodeSchema).max(12).optional(),
  }),
  ...placement,
});

export const updateBlockOpSchema = z.object({
  op: z.literal("update_block"),
  blockId,
  props: z.record(z.string(), z.unknown()),
  /** `merge` (default) sets the given top-level props; `replace` swaps the whole props object. */
  mode: z.enum(["merge", "replace"]).default("merge"),
});

export const removeBlockOpSchema = z.object({ op: z.literal("remove_block"), blockId });

export const moveBlockOpSchema = z.object({ op: z.literal("move_block"), blockId, ...placement });

export const pageSeoPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    locale: z.string().min(2).max(35).optional(),
    noindex: z.boolean().optional(),
  })
  .refine((seo) => Object.keys(seo).length > 0, { error: "set at least one SEO field" });

export const setPageSeoOpSchema = z.object({ op: z.literal("set_page_seo"), seo: pageSeoPatchSchema });

export const setLayoutOpSchema = z.object({
  op: z.literal("set_layout"),
  layout: z.object({ id: z.string().min(1).max(64), version: z.int().positive() }),
});

export const pageOperationSchema = z.discriminatedUnion("op", [
  addBlockOpSchema,
  updateBlockOpSchema,
  removeBlockOpSchema,
  moveBlockOpSchema,
  setPageSeoOpSchema,
  setLayoutOpSchema,
]);
export type PageOperation = z.infer<typeof pageOperationSchema>;
export type PageOperationInput = z.input<typeof pageOperationSchema>;

export const MAX_OPERATIONS_PER_PATCH = 100;
export const pageOperationsSchema = z.array(pageOperationSchema).min(1).max(MAX_OPERATIONS_PER_PATCH);

export interface OperationContext {
  /** New unique block id. */
  newId(): string;
  /** Latest version and default props of a block type, or undefined when the type is unknown. */
  blockDefaults(type: string, version?: number): { version: number; props: Record<string, unknown> } | undefined;
}

export interface OperationResult {
  op: PageOperation["op"];
  /** The block the operation touched (the new id for `add_block`). */
  blockId?: string;
}

export class PageOperationError extends Error {
  readonly index: number;
  readonly code: "not_found" | "invalid";

  constructor(index: number, code: "not_found" | "invalid", message: string) {
    super(message);
    this.name = "PageOperationError";
    this.index = index;
    this.code = code;
  }
}

/** Applies operations in order to a copy of `document`. Throws `PageOperationError` naming the failing operation. */
export function applyPageOperations(
  document: PageDocument,
  operations: readonly PageOperationInput[],
  context: OperationContext,
): { document: PageDocument; results: OperationResult[] } {
  const next: PageDocument = structuredClone(document);
  const results: OperationResult[] = [];
  operations.forEach((raw, index) => {
    const parsed = pageOperationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PageOperationError(index, "invalid", `operation ${index}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    results.push(applyOne(next, parsed.data, index, context));
  });
  return { document: next, results };
}

function applyOne(document: PageDocument, operation: PageOperation, index: number, context: OperationContext): OperationResult {
  const fail = (code: "not_found" | "invalid", message: string): never => {
    throw new PageOperationError(index, code, `operation ${index} (${operation.op}): ${message}`);
  };

  switch (operation.op) {
    case "add_block": {
      const defaults = context.blockDefaults(operation.block.type, operation.block.version);
      if (!defaults) return fail("invalid", `unknown block type "${operation.block.type}"`);
      const id = operation.block.id ?? context.newId();
      if (findBlock(document.blocks, id)) fail("invalid", `block id "${id}" already exists`);
      const node: BlockNode = {
        id,
        type: operation.block.type,
        version: defaults.version,
        props: { ...structuredClone(defaults.props), ...(operation.block.props ?? {}) },
      };
      if (operation.block.children?.length) node.children = structuredClone(operation.block.children);
      insertAt(document, node, operation, fail);
      return { op: operation.op, blockId: id };
    }
    case "update_block": {
      const found = findBlock(document.blocks, operation.blockId);
      if (!found) return fail("not_found", `block "${operation.blockId}" does not exist`);
      found.node.props = operation.mode === "replace" ? { ...operation.props } : { ...found.node.props, ...operation.props };
      return { op: operation.op, blockId: operation.blockId };
    }
    case "remove_block": {
      const found = findBlock(document.blocks, operation.blockId);
      if (!found) return fail("not_found", `block "${operation.blockId}" does not exist`);
      found.list.splice(found.index, 1);
      cleanupChildren(found.parent);
      return { op: operation.op, blockId: operation.blockId };
    }
    case "move_block": {
      const found = findBlock(document.blocks, operation.blockId);
      if (!found) return fail("not_found", `block "${operation.blockId}" does not exist`);
      if (operation.parentId && (operation.parentId === operation.blockId || findBlock(found.node.children ?? [], operation.parentId))) {
        fail("invalid", "a block cannot be moved inside itself");
      }
      if (operation.beforeId === operation.blockId || operation.afterId === operation.blockId) {
        fail("invalid", "a block cannot be placed relative to itself");
      }
      found.list.splice(found.index, 1);
      cleanupChildren(found.parent);
      insertAt(document, found.node, operation, fail);
      return { op: operation.op, blockId: operation.blockId };
    }
    case "set_page_seo": {
      document.meta = { ...document.meta, ...operation.seo };
      return { op: operation.op };
    }
    case "set_layout": {
      document.layout = { ...operation.layout };
      return { op: operation.op };
    }
  }
}

interface Located {
  node: BlockNode;
  list: BlockNode[];
  index: number;
  parent: BlockNode | null;
}

export function findBlock(blocks: BlockNode[], id: string, parent: BlockNode | null = null): Located | null {
  for (const [index, node] of blocks.entries()) {
    if (node.id === id) return { node, list: blocks, index, parent };
    if (node.children) {
      const nested = findBlock(node.children, id, node);
      if (nested) return nested;
    }
  }
  return null;
}

function cleanupChildren(parent: BlockNode | null): void {
  if (parent?.children && parent.children.length === 0) delete parent.children;
}

function insertAt(
  document: PageDocument,
  node: BlockNode,
  target: { parentId?: string | null | undefined; beforeId?: string | undefined; afterId?: string | undefined },
  fail: (code: "not_found" | "invalid", message: string) => never,
): void {
  if (target.beforeId && target.afterId) fail("invalid", "give beforeId or afterId, not both");
  const anchorId = target.beforeId ?? target.afterId;
  let list: BlockNode[];
  if (target.parentId === undefined && anchorId) {
    // No explicit parent: the anchor sibling decides the list, wherever it is nested.
    const sibling = findBlock(document.blocks, anchorId);
    if (!sibling) return fail("not_found", `sibling block "${anchorId}" does not exist`);
    list = sibling.list;
  } else if (target.parentId) {
    const parent = findBlock(document.blocks, target.parentId);
    if (!parent) return fail("not_found", `parent block "${target.parentId}" does not exist`);
    parent.node.children ??= [];
    list = parent.node.children;
  } else {
    list = document.blocks;
  }
  if (!anchorId) {
    list.push(node);
    return;
  }
  const anchor = list.findIndex((sibling) => sibling.id === anchorId);
  if (anchor < 0) fail("not_found", `sibling block "${anchorId}" is not in the target list`);
  list.splice(target.beforeId ? anchor : anchor + 1, 0, node);
}
