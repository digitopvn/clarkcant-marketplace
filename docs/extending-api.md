# Adding an API route

The public API is a Hono app built with `@hono/zod-openapi` in `packages/api`. The web Worker mounts it under
`/api/v1` and serves the generated OpenAPI 3.1 document at `/openapi.json`. The SDK, CLI ([docs/cli.md](cli.md)) and
MCP server ([docs/mcp.md](mcp.md)) are built from that document, so the route definition is the contract.

## Steps

1. **Service first.** Put the behaviour in `packages/marketplace` (validation, scopes via `requireScope`, queries,
   audit). The route only translates HTTP. Routes contain no SQL.
2. **Contract.** Reuse or add Zod schemas in `packages/contracts` when other clients need them; register response
   schemas with `.openapi("Name")` so they appear as named components.
3. **Route.** In `packages/api/src/routes/<area>.ts`, declare it with `createRoute` (`method`, `path`,
   `operationId`, `tags`, `summary`, request schemas, every response including `...errorResponses(...)` from
   `src/http/errors.ts`), then implement it on `createRouter()` (`src/http/router.ts`).
   `routes/health.ts` is the smallest complete example.
4. **Mount.** Add the router in `packages/api/src/app.ts` if it is a new file.
5. **Test.** `packages/api/test/*.test.ts` run the real app against D1 in workerd.
   `openapi-completeness.test.ts` fails if an operation lacks an id, tag, auth description, request or response
   schema, or the shared error body.
6. **Regenerate the SDK types** with `pnpm --filter @marketplace/sdk openapi:generate` and commit the result.

## Conventions

- Handlers read `c.var.context` (`deps`, `vars`) and `c.var.actor`; they never read bindings directly.
- Errors are thrown as `MarketplaceError` and mapped centrally to status and
  `{ error: { code, message, requestId, details? } }`. Do not build error bodies by hand.
- Every response carries `x-request-id`; include it in logs.
- Write routes that accept cookie sessions reject cross-site requests (`forbidden`); token callers are unaffected.
- Public read routes set an explicit `Cache-Control`; anything user-specific is `no-store`.
- Rate limiting is applied by the web middleware from the path, not per route. A new expensive route that is not
  under `/api/v1/search` or `/api/v1/publish` falls in the general `api` bucket; add a bucket in
  `apps/web/src/middleware/rate-limit.ts` (and a binding in `wrangler.jsonc`) if it needs a tighter limit.
