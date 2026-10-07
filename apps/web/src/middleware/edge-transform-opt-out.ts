import type { MiddlewareHandler } from "astro";

/**
 * HTML pages refuse Cloudflare's edge rewriting with `Cache-Control: no-transform`.
 *
 * Why: with Web Analytics automatic setup enabled on the zone, Cloudflare's edge injects its beacon
 * (`static.cloudflareinsights.com/beacon.min.js/v…`) into every HTML response it proxies, before the visitor has made
 * any consent choice. The beacon may only load after analytics opt-in (the consent banner adds it), so the page itself
 * opts out of injection instead of relying on a dashboard setting that can drift. `no-transform` is the documented
 * opt-out (developers.cloudflare.com/web-analytics/faq). It also stops the other edge rewrites (Rocket Loader, email
 * obfuscation, HTTPS rewrites), all of which would add inline scripts the hashed CSP blocks anyway.
 *
 * `no-transform` also stops the edge from compressing the response, so the page is compressed here: on Workers the
 * runtime encodes a body as its `content-encoding` header says (`encodeBody: "automatic"`), and the edge passes the
 * encoded body through untouched. Local servers (`astro dev`, `astro preview`, `wrangler dev`) decode or re-encode it
 * in their proxy, so the header is safe there too.
 */

/** Encodings the Workers runtime applies to a response body by itself, in order of preference. */
const ENCODINGS = ["br", "gzip"] as const;
export type BodyEncoding = (typeof ENCODINGS)[number];

/** Adds `no-transform` to a `Cache-Control` value, keeping every directive the route chose. */
export function withNoTransform(cacheControl: string | null): string {
  const directives = (cacheControl ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter(Boolean);
  if (directives.some((directive) => directive.toLowerCase() === "no-transform")) return directives.join(", ");
  return [...directives, "no-transform"].join(", ");
}

/** The encoding to apply for an `Accept-Encoding` request header, or null when the client accepts neither. */
export function preferredEncoding(acceptEncoding: string | null): BodyEncoding | null {
  const accepted = new Set<string>();
  for (const entry of (acceptEncoding ?? "").split(",")) {
    const [name = "", ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name);
  }
  return ENCODINGS.find((encoding) => accepted.has(encoding)) ?? null;
}

function isHtml(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().startsWith("text/html") ?? false;
}

function appendVary(current: string | null, value: string): string {
  const names = (current ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  return names.some((name) => name.toLowerCase() === value.toLowerCase() || name === "*") ? names.join(", ") : [...names, value].join(", ");
}

/**
 * Marks an HTML response `no-transform` and, when `encoding` is given and the body is not encoded yet, asks the
 * runtime to compress it. Other responses are returned unchanged. Responses with immutable headers are re-wrapped.
 */
export function optOutOfEdgeTransforms(response: Response, encoding: BodyEncoding | null): Response {
  if (!isHtml(response)) return response;
  const compress = encoding !== null && response.body !== null && !response.headers.has("content-encoding");
  const apply = (headers: Headers) => {
    headers.set("cache-control", withNoTransform(headers.get("cache-control")));
    if (!compress) return;
    headers.set("content-encoding", encoding);
    headers.delete("content-length");
    headers.set("vary", appendVary(headers.get("vary"), "Accept-Encoding"));
  };
  try {
    apply(response.headers);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    apply(copy.headers);
    return copy;
  }
}

export const edgeTransformOptOut: MiddlewareHandler = async (context, next) => {
  const response = await next();
  return optOutOfEdgeTransforms(response, preferredEncoding(context.request.headers.get("accept-encoding")));
};
