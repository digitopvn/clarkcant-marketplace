import { apiAudience, mcpAudience, resolveAuthOrigin, resolveRequestAuth, type AuthRuntime } from "@marketplace/auth";
import { ANONYMOUS_ACTOR, actorHasScope, isMarketplaceError, type Actor, type RuntimeVars } from "@marketplace/contracts";
import type { MarketplaceDeps } from "@marketplace/marketplace";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { createMarketplaceMcpServer } from "./create-server";
import { findMarketplaceTool } from "./marketplace-tools";

export const MCP_PATH = "/mcp";
/** RFC 9728 metadata for the `/mcp` resource: `/.well-known/oauth-protected-resource` + the resource path. */
export const MCP_PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;
/** Upper bound on a JSON-RPC request body; tool inputs (base64 media included) fit well below it. */
export const MAX_MCP_BODY_BYTES = 8 * 1024 * 1024;

export interface McpEndpointOptions {
  deps: MarketplaceDeps;
  vars: RuntimeVars;
  /** Builds Better Auth for requests that carry a bearer credential. */
  resolveAuth(request: Request): AuthRuntime | Promise<AuthRuntime>;
  previewSecret?: () => string | undefined;
  /** Reporting hook for unexpected tool failures and transport errors (never alters the response). */
  onError?: (error: unknown) => void;
}

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** `WWW-Authenticate` challenge pointing MCP clients at the protected-resource metadata (MCP authorization spec). */
function challenge(status: 401 | 403, origin: string, fields: { error?: string; description?: string; scope?: string }): Response {
  const params = [
    fields.error ? `error=${quote(fields.error)}` : null,
    fields.description ? `error_description=${quote(fields.description)}` : null,
    fields.scope ? `scope=${quote(fields.scope)}` : null,
    `resource_metadata=${quote(`${origin}${MCP_PROTECTED_RESOURCE_METADATA_PATH}`)}`,
  ].filter((entry): entry is string => entry !== null);
  return Response.json(
    { error: fields.error ?? "unauthorized", error_description: fields.description ?? "Authentication required" },
    {
      status,
      headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}`, "Cache-Control": "no-store" },
    },
  );
}

interface JsonRpcMessage {
  method?: unknown;
  params?: { name?: unknown } | null;
}

/** Names of the tools a POSTed JSON-RPC payload (a message or a 2025-era batch) calls. */
async function calledTools(request: Request): Promise<string[]> {
  if (request.method !== "POST") return [];
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_MCP_BODY_BYTES) return [];
  let payload: unknown;
  try {
    payload = await request.clone().json();
  } catch {
    // Malformed JSON is the protocol handler's to reject with a JSON-RPC parse error.
    return [];
  }
  const messages = (Array.isArray(payload) ? payload : [payload]) as JsonRpcMessage[];
  return messages
    .filter((message) => message && message.method === "tools/call" && typeof message.params?.name === "string")
    .map((message) => message.params?.name as string);
}

/**
 * Resolves the caller from `Authorization: Bearer` only: a personal API token, an OAuth access token issued for
 * `<site>/mcp` (or the REST API) or a device-flow session token. Session cookies are ignored, so a cross-site page
 * cannot drive MCP tools with a visitor's browser session.
 */
async function resolveActor(request: Request, options: McpEndpointOptions, origin: string): Promise<Actor | Response> {
  if (!request.headers.has("authorization")) return ANONYMOUS_ACTOR;
  try {
    const runtime = await options.resolveAuth(request);
    const { actor } = await resolveRequestAuth(runtime, request, { audiences: [mcpAudience(origin), apiAudience(origin)] });
    return actor;
  } catch (error) {
    if (isMarketplaceError(error) && error.code === "unauthorized") {
      return challenge(401, origin, { error: "invalid_token", description: error.message });
    }
    throw error;
  }
}

/**
 * Serves `POST /mcp` (stateless streamable HTTP; both the 2026-07-28 per-request protocol and the 2025 stateless
 * fallback). Anonymous callers get the public read tools. Calling a tool that needs a scope answers 401 with a
 * `WWW-Authenticate` challenge (no credential or an invalid one) or 403 `insufficient_scope`, so MCP clients can
 * start or step up OAuth.
 */
export async function handleMcpRequest(request: Request, options: McpEndpointOptions): Promise<Response> {
  const origin = resolveAuthOrigin(options.vars, request);
  const actor = await resolveActor(request, options, origin);
  if (actor instanceof Response) return actor;

  for (const name of await calledTools(request)) {
    const scope = findMarketplaceTool(name)?.scope;
    if (!scope || actorHasScope(actor, scope)) continue;
    if (actor.type === "anonymous") {
      return challenge(401, origin, { scope, description: `The ${name} tool requires signing in with the ${scope} scope` });
    }
    return challenge(403, origin, { error: "insufficient_scope", scope, description: `The ${name} tool requires the ${scope} scope` });
  }

  const context = { deps: options.deps, vars: options.vars, origin, actor, previewSecret: options.previewSecret };
  const handler = createMcpHandler(() => createMarketplaceMcpServer(context, { onUnexpected: options.onError }), {
    ...(options.onError ? { onerror: options.onError } : {}),
  });
  try {
    return await handler.fetch(request);
  } finally {
    await handler.close();
  }
}
