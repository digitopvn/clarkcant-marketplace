import type { APIRoute } from "astro";

import { serveDiscovery } from "../../../server/mcp";

export const prerender = false;

/** RFC 8414 metadata at the root and at the issuer-suffixed path (`/api/auth`), delegated to Better Auth. */
export const ALL: APIRoute = ({ request, params }) => serveDiscovery("oauth-authorization-server", params.path, request);
