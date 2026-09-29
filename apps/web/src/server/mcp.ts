import { env } from "cloudflare:workers";
import { isMarketplaceError, type ErrorBody } from "@marketplace/contracts";
import { handleMcpRequest, serveOAuthDiscovery, type DiscoveryDocument } from "@marketplace/mcp";
import { resolveAuthOrigin } from "@marketplace/auth";

import { createWebAuthRuntime } from "./auth";
import { createRequestContext, runtimeVars } from "./request-context";

/** A configuration failure (missing variable or secret) answers with the API error body naming it. */
function configurationErrorResponse(error: unknown): Response {
  if (!isMarketplaceError(error)) throw error;
  const body: ErrorBody = { error: { code: error.code, message: error.message, requestId: crypto.randomUUID(), details: error.details } };
  return Response.json(body, { status: error.status, headers: { "cache-control": "no-store" } });
}

/** The auth secret also signs page-preview links (the REST API does the same). */
function previewSecret(): string | undefined {
  const value = (env as unknown as Record<string, unknown>).BETTER_AUTH_SECRET;
  return typeof value === "string" ? value : undefined;
}

/** `/mcp`: the marketplace MCP server over the same services and D1 as the REST API. */
export async function serveMcp(request: Request, waitUntil: (promise: Promise<unknown>) => void): Promise<Response> {
  let context;
  try {
    context = createRequestContext();
  } catch (error) {
    return configurationErrorResponse(error);
  }
  try {
    return await handleMcpRequest(request, {
      deps: context.deps,
      vars: context.vars,
      resolveAuth: (incoming) => createWebAuthRuntime(incoming, { context, waitUntil }),
      previewSecret,
      onError: (error) => console.error(JSON.stringify({ event: "mcp.error", message: error instanceof Error ? error.message : String(error) })),
    });
  } catch (error) {
    return configurationErrorResponse(error);
  }
}

/** Root `/.well-known/*` OAuth discovery documents for MCP clients. */
export async function serveDiscovery(document: DiscoveryDocument, suffix: string | undefined, request: Request): Promise<Response> {
  try {
    const origin = resolveAuthOrigin(runtimeVars(), request);
    return await serveOAuthDiscovery(document, suffix, request, { origin, auth: () => createWebAuthRuntime(request) });
  } catch (error) {
    return configurationErrorResponse(error);
  }
}
