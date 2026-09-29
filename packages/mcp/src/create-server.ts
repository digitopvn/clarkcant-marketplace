import { isMarketplaceError } from "@marketplace/contracts";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";

import { toolsForActor, type McpToolContext, type MarketplaceTool } from "./marketplace-tools";

export const MCP_SERVER_NAME = "clarkcant-marketplace";
export const MCP_SERVER_VERSION = "0.1.0";

const INSTRUCTIONS =
  "ClarkCant Marketplace: discover ClarkCant widgets and packages, inspect their versions and permissions, and " +
  "(with the right scopes) submit packages, edit and publish marketplace pages and curate listings. Installing a " +
  "widget always happens in the ClarkCant app after the user reviews its permissions; no tool here installs " +
  "anything. Page edits take the draft revision id from get_page and fail with `conflict` when it is stale.";

/** Plain objects become `structuredContent` as-is; anything else is wrapped so the field stays an object. */
function structured(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
}

/**
 * Maps a failure to an MCP tool error result. Marketplace errors keep their stable `code` (the same codes as the
 * REST API) and details; anything unexpected is reported as `internal_error` without leaking its message.
 */
export function toolErrorResult(error: unknown, onUnexpected?: (error: unknown) => void): CallToolResult {
  const payload = isMarketplaceError(error)
    ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
    : { code: "internal_error", message: "The tool failed unexpectedly" };
  if (!isMarketplaceError(error)) onUnexpected?.(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${payload.code}: ${payload.message}` }],
    structuredContent: { error: payload },
  };
}

function register(server: McpServer, entry: MarketplaceTool, context: McpToolContext, onUnexpected?: (error: unknown) => void) {
  server.registerTool(
    entry.name,
    {
      title: entry.title,
      description: entry.description,
      inputSchema: entry.inputSchema,
      annotations: {
        title: entry.title,
        readOnlyHint: entry.readOnly,
        destructiveHint: false,
        idempotentHint: entry.readOnly,
        openWorldHint: false,
      },
    },
    async (input: unknown): Promise<CallToolResult> => {
      try {
        const result = await entry.run(context, input as never);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: structured(result) };
      } catch (error) {
        return toolErrorResult(error, onUnexpected);
      }
    },
  );
}

/** A fresh server exposing the tools this caller may use (one per request; the endpoint is stateless). */
export function createMarketplaceMcpServer(context: McpToolContext, options: { onUnexpected?: (error: unknown) => void } = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { instructions: INSTRUCTIONS });
  for (const entry of toolsForActor(context.actor)) register(server, entry, context, options.onUnexpected);
  return server;
}
