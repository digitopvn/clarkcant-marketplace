export { createId, createMarketplaceDeps, type MarketplaceBindings, type MarketplaceDeps } from "./deps";
export { parseInput } from "./validation";

export { checkHealth, type HealthReport } from "./system/health";

export {
  getPackage,
  getPackageInstall,
  listFeaturedPackages,
  listLatestPackages,
  listPackageVersions,
  listPackages,
  openInClarkCantUrl,
} from "./packages/package-queries";
export { featurePackage, setCurationStatus } from "./packages/curation-commands";
export type { CurationCommandOptions } from "./packages/curation-command";

export { findPackages, searchPackages, toFtsQuery } from "./search/search-packages";
export { removePackageSearchDocument, syncPackageSearchDocument } from "./search/search-index";

export { getCategory, listCategories } from "./categories/category-queries";
export { getCollection, listCollections } from "./collections/collection-queries";
export { getCollectionState, manageCollection } from "./collections/collection-commands";

/** Re-exported so interfaces serve media through the application layer without depending on storage details. */
export { mediaUrlFor, serveMediaObject } from "@marketplace/media";

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

export * from "./indexing";

export {
  createApiToken,
  generateApiTokenPlaintext,
  hashApiToken,
  isApiTokenFormat,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
  type VerifiedApiToken,
} from "./accounts/api-tokens";
export { linkDevice, listDeviceLinks, unlinkDevice } from "./accounts/device-links";
export {
  describeOAuthClient,
  listOAuthGrants,
  revokeOAuthGrant,
  type OAuthClientSummary,
  type OAuthGrant,
} from "./accounts/oauth-grants";
export { exportAccountData, getAccountProfile, listOwnedPackages } from "./accounts/account-service";
export {
  deleteAccount,
  removeOwnedMedia,
  type DeleteAccountOptions,
  type DeleteMediaIfUnreferenced,
} from "./accounts/account-deletion";

export {
  acceptInvitation,
  authorizePublisher,
  createPublisher,
  getMembershipRole,
  getPublisher,
  inviteMember,
  listMyPublishers,
  listPublisherInvitations,
  listPublisherMembers,
} from "./publishers/publisher-service";
export {
  addPublisherDomain,
  linkPublisherRepository,
  listPublisherDomains,
  listPublisherRepositories,
  verifyPublisherDomain,
  verifyPublisherRepository,
} from "./publishers/publisher-verification";
export { claimPackage, githubRepositoryFromUrl, listPublisherClaims } from "./publishers/package-claims";
export { createHttpVerificationPorts, type VerificationPorts } from "./publishers/verification-ports";

export * from "./pages";
