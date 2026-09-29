import type { APIRoute } from "astro";

import { serveDiscovery } from "../../../server/mcp";

export const prerender = false;

/** OpenID Connect discovery at the root and at the issuer-suffixed path (`/api/auth`), delegated to Better Auth. */
export const ALL: APIRoute = ({ request, params }) => serveDiscovery("openid-configuration", params.path, request);
