import { MarketplaceError, pageDocumentSchema, type BlockNode, type PageDocument } from "@marketplace/contracts";

import { assignRegions, getLayout } from "./layouts";
import { getBlock } from "./registry";

/** Stored documents are bounded so one page can never exhaust a Worker's memory or a D1 row. */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

export interface DocumentIssue {
  /** JSON path into the document, e.g. `["blocks", 2, "props", "title"]`. */
  path: (string | number)[];
  message: string;
  blockId?: string;
}

export type DocumentValidation = { ok: true; document: PageDocument } | { ok: false; issues: DocumentIssue[] };

/**
 * Full validation of a page document: the contracts envelope, then the layout, every block's type/version and props
 * (normalized through the block's schema, so defaults are filled in), child rules, region placement and size.
 * The returned document is what gets stored; nothing unvalidated is ever persisted.
 */
export function validatePageDocument(input: unknown): DocumentValidation {
  const envelope = pageDocumentSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      issues: envelope.error.issues.map((issue) => ({ path: issue.path.map(pathSegment), message: issue.message })),
    };
  }
  const document = envelope.data;
  const issues: DocumentIssue[] = [];

  const layout = getLayout(document.layout.id, document.layout.version);
  if (!layout) {
    issues.push({ path: ["layout"], message: `unknown layout ${document.layout.id}@${document.layout.version}` });
  }

  const normalizeList = (nodes: readonly BlockNode[], path: (string | number)[]): BlockNode[] =>
    nodes.map((node, index) => normalizeNode(node, [...path, index]));

  const normalizeNode = (node: BlockNode, path: (string | number)[]): BlockNode => {
    const block = getBlock(node.type, node.version);
    if (!block) {
      issues.push({ path: [...path, "type"], blockId: node.id, message: `unknown block ${node.type}@${node.version}` });
      return node;
    }
    let props = node.props;
    const parsed = block.parseProps(node.props);
    if (parsed.success) {
      props = parsed.props;
    } else {
      for (const issue of parsed.issues) {
        issues.push({ path: [...path, "props", ...issue.path.map(pathSegment)], blockId: node.id, message: issue.message });
      }
    }
    const children = node.children ?? [];
    if (children.length > 0 && block.allowedChildren.length === 0) {
      issues.push({ path: [...path, "children"], blockId: node.id, message: `${node.type} blocks cannot contain other blocks` });
    } else if (children.length > block.maxChildren) {
      issues.push({ path: [...path, "children"], blockId: node.id, message: `${node.type} holds at most ${block.maxChildren} blocks` });
    }
    children.forEach((child, index) => {
      if (block.allowedChildren.length > 0 && !block.allowedChildren.includes(child.type)) {
        issues.push({
          path: [...path, "children", index, "type"],
          blockId: child.id,
          message: `${child.type} is not allowed inside ${node.type}; allowed: ${block.allowedChildren.join(", ")}`,
        });
      }
    });
    const normalized: BlockNode = { id: node.id, type: node.type, version: node.version, props };
    if (children.length > 0) normalized.children = normalizeList(children, [...path, "children"]);
    return normalized;
  };

  const blocks = normalizeList(document.blocks, ["blocks"]);

  // Region placement is only meaningful once every top-level block is a known type.
  if (layout && blocks.every((block) => getBlock(block.type, block.version))) {
    const placement = assignRegions(layout, blocks);
    if (!placement.ok) {
      const block = blocks[placement.index];
      issues.push({
        path: ["blocks", placement.index],
        ...(block ? { blockId: block.id } : {}),
        message:
          `${block?.type ?? "block"} cannot appear here in the ${layout.label} layout; ` +
          `blocks allowed from this point: ${placement.allowed.join(", ")}`,
      });
    }
  }

  const normalized: PageDocument = { ...document, blocks };
  const bytes = new TextEncoder().encode(JSON.stringify(normalized)).length;
  if (bytes > MAX_DOCUMENT_BYTES) {
    issues.push({ path: [], message: `document is ${bytes} bytes; the limit is ${MAX_DOCUMENT_BYTES}` });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, document: normalized };
}

/** Like `validatePageDocument`, but throws the standard `validation_failed` error with every issue as details. */
export function parsePageDocument(input: unknown): PageDocument {
  const result = validatePageDocument(input);
  if (result.ok) return result.document;
  throw new MarketplaceError("validation_failed", "page document failed validation", {
    details: result.issues.map((issue) => ({ ...issue, path: issue.path.map(String) })),
  });
}

function pathSegment(segment: PropertyKey): string | number {
  return typeof segment === "number" ? segment : String(segment);
}

/** Depth-first list of every block in a document. */
export function flattenBlocks(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.flatMap((block) => [block, ...flattenBlocks(block.children ?? [])]);
}
