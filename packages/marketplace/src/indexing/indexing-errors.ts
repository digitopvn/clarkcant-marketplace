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

export const INDEXING_REJECTION_CODES = [
  "package_not_found",
  "version_not_found",
  "invalid_packument",
  "missing_integrity",
  "integrity_mismatch",
  "tarball_too_large",
  "invalid_tarball",
  "manifest_missing",
  "manifest_invalid",
  "manifest_mismatch",
  "untrusted_tarball_url",
] as const;

export type IndexingRejectionCode = (typeof INDEXING_REJECTION_CODES)[number];

export function isIndexingRejection(error: unknown): error is IndexingRejectedError {
  return error instanceof IndexingRejectedError;
}

/** The error text a rejected submission is stored with: the code, then the reason. */
export function rejectionErrorText(code: IndexingRejectionCode, message: string): string {
  return `${code}: ${message}`;
}

const REJECTION_PREFIXES = INDEXING_REJECTION_CODES.map((code) => `${code}: `);

/**
 * Whether a failed submission's stored error records a deterministic rejection (see {@link rejectionErrorText}) rather
 * than a transient failure that ran out of retries.
 */
export function isRejectionErrorText(error: string | null): boolean {
  return error !== null && REJECTION_PREFIXES.some((prefix) => error.startsWith(prefix));
}
