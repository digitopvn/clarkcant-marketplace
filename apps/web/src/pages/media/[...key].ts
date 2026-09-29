import { env } from "cloudflare:workers";
import { serveMediaObject } from "@marketplace/marketplace";
import type { APIRoute } from "astro";

export const prerender = false;

/**
 * Content-addressed media (`/media/sha256/ab/cd/<digest>.<ext>`) from the MEDIA R2 bucket. Keys are validated, and
 * responses are immutable, `nosniff` and sandboxed by CSP, in `serveMediaObject`.
 */
const serve: APIRoute = ({ params, request }) => serveMediaObject(env.MEDIA, params.key ?? "", request);

export const GET = serve;
export const HEAD = serve;
