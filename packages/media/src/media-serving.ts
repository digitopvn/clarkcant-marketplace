import { MEDIA_KEY_PATTERN } from "./media-store.ts";

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * Media responses are never documents: even the marketplace's own SVGs are served under a CSP that forbids script
 * and sandboxes the response, so a crafted object could not run code on the site origin.
 */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-site",
} as const;

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

/**
 * Serves one content-addressed object. The key is validated against the storage layout before touching R2, so the
 * route can never be used to read anything outside `sha256/…`. Keys are immutable (the digest is the name), which is
 * why responses may be cached forever.
 */
export async function serveMediaObject(bucket: R2Bucket, key: string, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = plain(405, "Method not allowed");
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }
  if (!MEDIA_KEY_PATTERN.test(key)) return plain(404, "Not found");

  const etag = `"${key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("."))}"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": IMMUTABLE_CACHE } });
  }

  const object = request.method === "HEAD" ? await bucket.head(key) : await bucket.get(key);
  if (!object) return plain(404, "Not found");

  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", IMMUTABLE_CACHE);
  headers.set("ETag", etag);
  const body = "body" in object ? (object as R2ObjectBody).body : null;
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}
