export {
  addBlock,
  createPage,
  getPage,
  getPageRevision,
  getPublishedPage,
  listPageRevisions,
  listPages,
  moveBlock,
  pagePath,
  patchPage,
  previewPage,
  publishPage,
  removeBlock,
  renderDocumentForEditor,
  renderPageDocument,
  resolvePreview,
  rollbackPage,
  savePageDraft,
  setPageSeo,
  updateBlock,
  type CommandOptions,
  type PreviewSigning,
  type RenderSettings,
  type ResolvedPreview,
} from "./page-service";
export { DEFAULT_PAGES, ensureDefaultPages, type DefaultPagesResult } from "./default-pages";
export { createPageDataPort } from "./page-data-port";
export { assertPreviewSecret } from "./preview-token";
export * from "./page-schemas";
// Registry metadata for transports (API, MCP) that must not depend on the engine package directly.
export { describeBlocks, listLayouts } from "@marketplace/page-engine";
