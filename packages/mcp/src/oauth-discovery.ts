import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { AUTH_BASE_PATH, OAUTH_API_SCOPES, OIDC_SCOPES, mcpAudience, type AuthRuntime } from "@marketplace/auth";

import { MCP_PATH } from "./mcp-endpoint";

/**
 * Root-level OAuth discovery for MCP clients. The authorization server is Better Auth mounted at `/api/auth` (its
 * issuer), so RFC 8414 clients look for `/.well-known/oauth-authorization-server/api/auth` and older ones for the
 * root document; both answer with Better Auth's own metadata. The protected-resource document (RFC 9728) names
 * `<site>/mcp` as the resource and Better Auth as its authorization server.
 */

export type DiscoveryDocument = "oauth-authorization-server" | "openid-configuration" | "oauth-protected-resource";

const DISCOVERY_CACHE = "public, max-age=300";

/** The path suffixes each document answers under `/.well-known/<document>` (`""` is the bare document). */
const ACCEPTED_SUFFIXES: Record<DiscoveryDocument, readonly string[]> = {
  "oauth-authorization-server": ["", AUTH_BASE_PATH.slice(1)],
  "openid-configuration": ["", AUTH_BASE_PATH.slice(1)],
  "oauth-protected-resource": ["", MCP_PATH.slice(1)],
};

export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpAudience(origin),
    authorization_servers: [`${origin}${AUTH_BASE_PATH}`],
    scopes_supported: [...OIDC_SCOPES, ...OAUTH_API_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "ClarkCant Marketplace MCP",
  };
}

/**
 * Answers `/.well-known/<document>/<suffix>`; unknown suffixes are 404 so the discovery surface stays exactly the
 * documented one. `auth` is built lazily: the protected-resource document needs no Better Auth instance.
 */
export async function serveOAuthDiscovery(
  document: DiscoveryDocument,
  suffix: string | undefined,
  request: Request,
  options: { origin: string; auth: () => AuthRuntime },
): Promise<Response> {
  const normalized = (suffix ?? "").replace(/^\/+|\/+$/g, "");
  if (!ACCEPTED_SUFFIXES[document].includes(normalized)) {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const headers = { "cache-control": DISCOVERY_CACHE, "access-control-allow-origin": "*" };
  if (document === "oauth-protected-resource") {
    return Response.json(protectedResourceMetadata(options.origin), { headers });
  }
  const runtime = options.auth();
  const serve =
    document === "oauth-authorization-server"
      ? oauthProviderAuthServerMetadata(runtime.auth, { headers })
      : oauthProviderOpenIdConfigMetadata(runtime.auth, { headers });
  return serve(request);
}
