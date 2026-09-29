/**
 * A package version the marketplace refuses to list, for a reason retrying cannot change (missing or invalid
 * manifest, integrity mismatch, unknown version). The pipeline records `code` and `message` on the submission and in
 * the audit log instead of retrying. Anything else thrown during indexing is treated as transient and retried.
 */
export class IndexingRejectedError extends Error {
  readonly code: IndexingRejectionCode;
  readonly details: unknown;

  constructor(code: IndexingRejectionCode, message: string, details?: unknown) {
    super(message);
    this.name = "IndexingRejectedError";
    this.code = code;
    this.details = details;
  }
}

export type IndexingRejectionCode =
  | "package_not_found"
  | "version_not_found"
  | "invalid_packument"
  | "missing_integrity"
  | "integrity_mismatch"
  | "tarball_too_large"
  | "invalid_tarball"
  | "manifest_missing"
  | "manifest_invalid"
  | "manifest_mismatch"
  | "untrusted_tarball_url";

export function isIndexingRejection(error: unknown): error is IndexingRejectedError {
  return error instanceof IndexingRejectedError;
}
