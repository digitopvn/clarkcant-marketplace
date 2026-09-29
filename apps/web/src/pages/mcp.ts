import type { APIRoute } from "astro";

import { serveMcp } from "../server/mcp";

export const prerender = false;

/** MCP (streamable HTTP, stateless). Tools and auth are defined in `@marketplace/mcp`; see docs/mcp.md. */
export const ALL: APIRoute = ({ request, locals }) => serveMcp(request, (promise) => locals.cfContext.waitUntil(promise));
