import { IndexingRejectedError } from "./indexing-errors";

/**
 * Subresource Integrity checks for npm tarballs. npm publishes `dist.integrity` as one or more
 * `<algorithm>-<base64 digest>` tokens; only sha512 is accepted, because sha1 (`dist.shasum`) is not collision
 * resistant and must never be the reason a tarball is trusted.
 */

export interface IntegrityVerification {
  algorithm: "sha512";
  /** The token that matched, e.g. `sha512-…`. */
  integrity: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Returns the sha512 tokens of an SRI string (options such as `?foo` are ignored). */
export function sha512Tokens(integrity: string): string[] {
  return integrity
    .trim()
    .split(/\s+/)
    .map((token) => token.split("?")[0] ?? "")
    .filter((token) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(token));
}

export async function computeSha512Integrity(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
  return `sha512-${toBase64(digest)}`;
}

/** Throws `IndexingRejectedError` unless `bytes` match one of the sha512 digests in `integrity`. */
export async function verifyTarballIntegrity(bytes: Uint8Array, integrity: string): Promise<IntegrityVerification> {
  const expected = sha512Tokens(integrity);
  if (expected.length === 0) {
    throw new IndexingRejectedError("missing_integrity", "npm did not publish a sha512 integrity for this version", {
      integrity,
    });
  }
  const actual = await computeSha512Integrity(bytes);
  const match = expected.find((token) => token === actual);
  if (!match) {
    throw new IndexingRejectedError("integrity_mismatch", "tarball bytes do not match the published sha512 integrity", {
      expected,
      actual,
    });
  }
  return { algorithm: "sha512", integrity: match };
}
