import { z } from "zod";

import { codeInstallSnippetBlock, logoCloudBlock } from "./blocks/brand-blocks";
import { comparisonBlock, ctaBlock, faqBlock, statsBlock } from "./blocks/content-blocks";
import { heroBlock } from "./blocks/hero";
import { mediaBlock } from "./blocks/media";
import { collectionBlock, featuredPackagesBlock, packageGridBlock, publisherProfileBlock } from "./blocks/package-blocks";
import { richTextBlock } from "./blocks/rich-text";
import type { BlockEditorSpec, RegisteredBlock } from "./types";

/**
 * Every block the engine can render, keyed by `type@version`. Adding a block = write its definition with
 * `defineBlock` and list it here; a breaking prop change ships as a new version next to the old one so stored pages
 * keep rendering.
 */
const BLOCKS: readonly RegisteredBlock[] = [
  heroBlock,
  richTextBlock,
  mediaBlock,
  packageGridBlock,
  featuredPackagesBlock,
  collectionBlock,
  statsBlock,
  ctaBlock,
  faqBlock,
  comparisonBlock,
  logoCloudBlock,
  codeInstallSnippetBlock,
  publisherProfileBlock,
];

const byKey = new Map<string, RegisteredBlock>();
const latestByType = new Map<string, RegisteredBlock>();
for (const block of BLOCKS) {
  const key = `${block.type}@${block.version}`;
  if (byKey.has(key)) throw new Error(`duplicate block registration ${key}`);
  byKey.set(key, block);
  const latest = latestByType.get(block.type);
  if (!latest || latest.version < block.version) latestByType.set(block.type, block);
}

export function getBlock(type: string, version: number): RegisteredBlock | undefined {
  return byKey.get(`${type}@${version}`);
}

export function getLatestBlock(type: string): RegisteredBlock | undefined {
  return latestByType.get(type);
}

export function listBlocks(): readonly RegisteredBlock[] {
  return BLOCKS;
}

/** Serializable description of a block for editors, API clients and agents (props as JSON Schema). */
export interface BlockDescription {
  type: string;
  version: number;
  label: string;
  icon: string | null;
  description: string;
  allowedChildren: string[];
  maxChildren: number;
  defaultProps: Record<string, unknown>;
  propsJsonSchema: Record<string, unknown>;
  fields: BlockEditorSpec["fields"];
}

export function describeBlock(block: RegisteredBlock): BlockDescription {
  return {
    type: block.type,
    version: block.version,
    label: block.editor.label,
    icon: block.editor.icon ?? null,
    description: block.editor.description,
    allowedChildren: [...block.allowedChildren],
    maxChildren: block.maxChildren,
    defaultProps: structuredClone(block.defaultProps),
    propsJsonSchema: z.toJSONSchema(block.propsSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
    fields: block.editor.fields,
  };
}

/** Latest version of every block type, in palette order. */
export function describeBlocks(): BlockDescription[] {
  return [...latestByType.values()].map(describeBlock);
}
