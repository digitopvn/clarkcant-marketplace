export type {
  BlockDefinition,
  BlockEditorSpec,
  BlockRenderContext,
  EditorField,
  LayoutDefinition,
  LayoutRegion,
  MarketplaceStats,
  MediaAsset,
  PageDataPort,
  PublisherProfile,
  RegisteredBlock,
  RenderMode,
  RenderOptions,
  RenderedPage,
} from "./types";

export { defineBlock } from "./define-block";
export { describeBlock, describeBlocks, getBlock, getLatestBlock, listBlocks, type BlockDescription } from "./registry";
export { assignRegions, defaultLayoutForKind, getLayout, listLayouts } from "./layouts";
export {
  MAX_DOCUMENT_BYTES,
  flattenBlocks,
  parsePageDocument,
  validatePageDocument,
  type DocumentIssue,
  type DocumentValidation,
} from "./validate-document";
export { renderPage } from "./render-page";
export {
  MAX_OPERATIONS_PER_PATCH,
  PageOperationError,
  applyPageOperations,
  findBlock,
  pageOperationSchema,
  pageOperationsSchema,
  pageSeoPatchSchema,
  type OperationContext,
  type OperationResult,
  type PageOperation,
  type PageOperationInput,
} from "./operations";
export { BLOCK_STYLES } from "./block-styles";
export { absoluteUrl, escapeHtml, isSafeUrl, jsonForScript, packagePath, safeHref } from "./html";
// Markdown text helpers, shared with the catalogue Markdown twins and llms.txt so escaping rules stay identical.
export { escapeMarkdown, joinMarkdown, mdCode, mdHeading, mdLink } from "./markdown-text";

import { getBlock, getLatestBlock } from "./registry";
import type { OperationContext } from "./operations";

/** Registry-backed defaults for `applyPageOperations` (server side; the builder passes described blocks instead). */
export function registryBlockDefaults(type: string, version?: number): ReturnType<OperationContext["blockDefaults"]> {
  const block = version === undefined ? getLatestBlock(type) : getBlock(type, version);
  return block ? { version: block.version, props: structuredClone(block.defaultProps) } : undefined;
}
