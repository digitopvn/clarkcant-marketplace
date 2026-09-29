# Phase 05 — Agent interfaces: OpenAPI, SDK, CLI, MCP, WebMCP (M4)

Status: pending · Wave 3 (parallel with 06) · Depends on 02, 03, 04.

## Owns (only these files)
- `packages/sdk/**` (new), `apps/cli/**` (new), `packages/mcp/**` (new), `packages/webmcp/**` (new)
- `apps/web/src/pages/mcp.ts` (streamable HTTP endpoint) and `apps/web/src/components/webmcp/**`
- OpenAPI completeness fixes in `packages/api/src/**` limited to schema metadata (descriptions, examples,
  security schemes, operationIds) — no behavior changes; report anything behavioral instead.

## Requirements
- OpenAPI: every `/api/v1` operation has operationId, tags, request/response schemas, error schema, security
  (bearer + cookie), `Idempotency-Key` / `If-Match` headers documented. Interactive docs page `/docs/api`
  (Scalar or similar via CDN-free bundle; or a server-rendered reference) — keep it lightweight.
- SDK (`@marketplace/sdk`): typed client generated from or typed against the OpenAPI/contracts (e.g. `openapi-typescript`
  types + small fetch wrapper, or Hono RPC `hc` types); handles bearer auth, idempotency keys, structured errors.
  Used by CLI; published-ready (name to be decided — keep `private: true` for now).
- CLI `clark-market` (citty or commander): `search <q>`, `info <name>`, `login` (device authorization flow; stores
  token in the OS config dir with 0600 perms), `logout`, `whoami`, `submit <name>[@version]`, `publish-page <slug|id>`
  (admin scope; publishes latest draft revision with expected revision check), `--json` on every command, `--api-url`
  / `CLARK_MARKET_API_URL`, exit codes documented. Uses the SDK only (no DB path). Tests run the CLI against the
  API app in-process or a local dev server.
- MCP (`@modelcontextprotocol/server` 2.x per research report; stateless `createMcpHandler` on `/mcp`):
  User tools: search_widgets, get_widget, get_widget_versions, get_widget_permissions, find_similar_widgets (FTS on
  facets/keywords now; Vectorize seam later), list_featured_widgets, submit_package, list_my_packages.
  Admin tools (only listed when the bearer token has the scope): get_page, create_page_draft, patch_page, preview_page,
  publish_page, upload_media (base64 ≤ limit, image types only), manage_collection, feature_package.
  All tools call packages/marketplace services with the resolved Actor; tool input schemas from contracts; errors
  mapped to MCP tool errors. Auth: bearer API token or OAuth access token from phase 04; anonymous gets read tools.
  Document client config (Claude/ChatGPT/Cursor) in `docs/mcp.md`.
- WebMCP (`document.modelContext.registerTool`, progressive enhancement, feature-detected, AbortSignal cleanup):
  package detail page registers: get_current_package, get_versions, inspect_permissions, find_similar_widgets,
  open_in_clarkcant (returns deep link + coordinate; never installs), copy_package_reference.
  Admin builder registers: update_selected_block, add_block, preview_page (call the same admin API with the session).
  Only contextual tools per page; no global inventory.

## Acceptance
- Tests: SDK against in-process API; CLI commands incl. `--json` and error exit codes; MCP: list tools (anon vs admin),
  call each read tool on valid/invalid input via an in-process MCP client; WebMCP registration unit test with a fake
  `document.modelContext` (browser API absent in test runtime — this is a test double of the browser API, not of our code).
- `pnpm verify && pnpm build` green.
