import type { APIRoute } from "astro";

import { api } from "../../server/api";

export const prerender = false;

/** Forwards every `/api/*` request to the shared Hono API; Astro adds no behaviour of its own here. */
export const ALL: APIRoute = ({ request, locals }) => api.fetch(request, undefined, locals.cfContext);
