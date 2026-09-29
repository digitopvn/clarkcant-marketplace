export { createId, createMarketplaceDeps, type MarketplaceBindings, type MarketplaceDeps } from "./deps";
export { parseInput } from "./validation";

export { checkHealth, type HealthReport } from "./system/health";

export {
  getPackage,
  listFeaturedPackages,
  listLatestPackages,
  listPackages,
} from "./packages/package-queries";

export { searchPackages, toFtsQuery } from "./search/search-packages";
export { removePackageSearchDocument, syncPackageSearchDocument } from "./search/search-index";

export { getCategory, listCategories } from "./categories/category-queries";
export { getCollection, listCollections } from "./collections/collection-queries";

export { listAuditEventsForSubject, prepareAuditEvent, recordAuditEvent } from "./audit/audit-writer";

export {
  IDEMPOTENCY_LEASE_MS,
  beginIdempotentRequest,
  completeIdempotentRequest,
  hashRequest,
  releaseIdempotentRequest,
  withIdempotency,
  type IdempotencyRef,
} from "./idempotency/idempotency-store";

export {
  discoverNpmPackages,
  handleIngestMessage,
  indexPackage,
  type IndexPackageParams,
  type IndexPackageResult,
} from "./indexing/indexing-seams";
