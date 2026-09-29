/**
 * The generated types record a digest of the OpenAPI document they came from. `servers` is dropped first because it
 * reflects whichever origin served the document; everything else must match the live document exactly.
 */
export function normalizeOpenApiDocument(document: unknown): Record<string, unknown> {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("OpenAPI document must be a JSON object");
  }
  const { servers: _servers, ...rest } = document as Record<string, unknown>;
  return rest;
}

/** Hex SHA-256 of the normalized document's JSON text (key order is the generator's, which is deterministic). */
export async function openApiDigest(document: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(normalizeOpenApiDocument(document)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
