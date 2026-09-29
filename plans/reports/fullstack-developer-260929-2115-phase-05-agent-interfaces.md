# Phase 05 — Agent interfaces: implementation report

Status: completed (2026-09-29). Nothing was committed, pushed, deployed or published. There are no schema or migration
changes.

## What was built

- **OpenAPI completion.** Every `/api/v1` operation now has a summary and a tag description, guarded by
  `packages/api/test/openapi-completeness.test.ts`. `/docs/api` renders a reference table from the live document.
- **`@marketplace/sdk`.** A typed client generated from the OpenAPI document; a drift test compares its digest with
  the served document. It has structured errors (`MarketplaceApiError`), bearer auth, idempotency keys, revision
  guards and an RFC 8628 device-flow helper.
- **`clark-market` CLI (`apps/cli`).** Built on commander. Every command goes through the SDK. It supports `--json`,
  documented exit codes, and an OS config-dir token store (0600 file, atomic write).
- **MCP server (`packages/mcp`, mounted at `/mcp`).** Stateless streamable HTTP. Each tool calls a
  `packages/marketplace` service with the caller's `Actor`, so there is no separate DB path. It adds OAuth
  protected-resource metadata and root `/.well-known` discovery.
- **WebMCP (`packages/webmcp`, plus `apps/web/src/components/webmcp/*`).** Page-scoped tools on package pages and in
  the admin page builder. They are feature-detected, withdrawn through an AbortSignal, and call only the SDK.

## File map

| Area | Files |
| --- | --- |
| SDK | `packages/sdk/src/{client,device-authorization,errors,types,index}.ts`, `scripts/generate-openapi.ts`, `src/generated/openapi.ts`, `test/sdk.test.ts`, `test/support/in-process-site.ts` (shared harness) |
| CLI | `apps/cli/src/{cli,main,token-store,file-token-store,index}.ts`, `bin/clark-market.mjs`, `test/cli.test.ts`, `test-node/file-token-store.test.ts`, `vitest{,.node}.config.ts` |
| MCP | `packages/mcp/src/{marketplace-tools,create-server,mcp-endpoint,oauth-discovery,index}.ts`, `test/mcp-endpoint.test.ts` |
| WebMCP | `packages/webmcp/src/{model-context,webmcp-tools,index}.ts`, `test/webmcp.test.ts` |
| Web | `apps/web/src/server/mcp.ts`, `src/pages/mcp.ts`, `src/pages/.well-known/{oauth-authorization-server,openid-configuration,oauth-protected-resource}/[...path].ts`, `src/pages/docs/api.astro`, `src/components/webmcp/Webmcp{Package,Builder}Tools.astro` |
| Include lines | `apps/web/src/pages/packages/[...name].astro`, `apps/web/src/pages/admin/pages/[id].astro` (one import and one element each) |
| Services | `packages/marketplace/src/media/upload-media.ts` (+ export), `packages/auth` (`mcpAudience`, `resources`, `audiences` option), `packages/api/src/app.ts` (tags/summaries, security typing) |
| Docs | `docs/mcp.md`, `docs/cli.md` |

## MCP tools and auth

| Tool | Scope | Notes |
| --- | --- | --- |
| `search_widgets`, `get_widget`, `get_widget_versions`, `get_widget_permissions`, `find_similar_widgets`, `list_featured_widgets` | none | Read-only; listed to everyone |
| `submit_package` | `packages:submit` | Idempotent through `idempotencyKey` |
| `list_my_packages` | `account:read` | |
| `get_page`, `create_page_draft`, `patch_page`, `preview_page` | `pages:write` | Page by id or slug; writes need `expectedRevisionId`; preview returns an absolute signed URL |
| `publish_page` | `pages:publish` | A stale revision gives `conflict` |
| `upload_media` | `media:write` | Base64 image, 5 MiB, bytes sniffed |
| `manage_collection`, `feature_package` | `packages:curate` | |

- `tools/list` returns only the tools the caller's scopes allow. Anonymous callers see the six read tools.
- Only `Authorization: Bearer` counts. Cookies are ignored on `/mcp`, which blocks cross-site driving of a visitor
  session. The accepted token audiences are `<origin>/mcp` and the API audience.
- Calling a scoped tool without a credential returns 401. The response carries
  `WWW-Authenticate: Bearer … scope, resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
- An invalid token returns 401 with `error="invalid_token"`.
- A caller that lacks the scope gets 403 with `error="insufficient_scope"`.
- Tool failures return `isError: true` with `structuredContent.error.{code,message,details}`, using the REST error
  codes.
- Discovery routes: `/.well-known/oauth-protected-resource[/mcp]` is RFC 9728, and
  `/.well-known/oauth-authorization-server[/api/auth]` plus `/.well-known/openid-configuration[/api/auth]` come from
  Better Auth's oauth-provider metadata.

## CLI commands

| Command | Auth | Exit codes |
| --- | --- | --- |
| `search <q...> [--limit --category --kind]` | none | 0; 2 bad `--limit`; 7 network |
| `info <name>` | none | 0; 4 not found |
| `login` | device flow | 0; 3 denied or expired; `--json` prints a pending line first |
| `logout` | stored | 0 (server-side sign-out is best effort) |
| `whoami` | login | 0; 3 not logged in |
| `submit <name>[@version]` | `packages:submit` | 0; 3; 6 validation |
| `publish-page <slug\|id>` | `pages:publish` | 0; 4; 5 conflict |

Exit code 1 means an unexpected error. `CLARK_MARKET_TOKEN` overrides the stored login, `CLARK_MARKET_API_URL` or
`--api-url` sets the origin, and `CLARK_MARKET_CONFIG_DIR` sets the config directory.

## Adding a tool or command

- **MCP tool.** Add an entry to `USER_TOOLS` or `ADMIN_TOOLS` in `packages/mcp/src/marketplace-tools.ts` with a
  name, zod `inputSchema`, `scope`, `readOnly`, and a `run` that calls a marketplace service with `context.actor`.
  If no service exists, add one first. Then extend `mcp-endpoint.test.ts`.
- **CLI command.** Add a `program.command(...)` block in `apps/cli/src/cli.ts` that uses the `client` from
  `context()` and prints through `print(human, data)`. Throw `MarketplaceApiError`/`CliError` for failures. Then
  extend `apps/cli/test/cli.test.ts`.
- Both procedures are also written up in `docs/mcp.md` and `docs/cli.md`.

## Test evidence

- `pnpm test` (root vitest) passed: 35 files passed and 1 skipped; 283 tests passed and 3 skipped. Phase-owned
  results:

  | Project | Tests | What they cover |
  | --- | --- | --- |
  | sdk | 11 | In-process API; a real device flow including the 5 s interval; `slow_down`/429/`access_denied`; abort; idempotency replay; stale revision gives conflict |
  | mcp | 11 | Anonymous, member and admin listing; each read tool on valid and invalid input; 401, 403 and `invalid_token`; cookie ignored; page edit, preview and publish with conflicts; media; curation; discovery |
  | webmcp | 7 | A fake modelContext: registration, abort unregister, and a dirty-builder refusal |
  | cli | 5 | `--json` and exit codes |
  | cli-node | 5 | Token file modes and atomic write; spawned bin `--version`; network error exits 7 |
- Per-package `typecheck` passed for auth, marketplace, api, sdk, mcp, webmcp, cli and web (`astro check`).
- Lint: my files are clean.
- The web bundle succeeded (`astro build --outDir <scratch>`) and the jobs bundle dry run succeeded.
  `migrations:check` passed.
- Dev smoke test on port 4325 (the server was stopped afterwards):
  - Anonymous `tools/list` returned the read tools, and `search_widgets` returned structured content.
  - Anonymous `publish_page` returned 401 with the correct `WWW-Authenticate`.
  - All three `/.well-known` routes and `/docs/api` returned 200.

## Gate failures outside this phase (noted, not edited)

- `pnpm lint`: `apps/web/src/middleware/request-log.ts:19` no-console (a phase 04/06 file). Because of this,
  `pnpm verify` stops at lint.
- Root `tsc`: `e2e/seo-a11y.spec.ts` has missing DOM lib types (phase 06).
- `pnpm -r typecheck`: `packages/page-engine/test/share-image.test.ts` is missing `blockDefaults` in its
  `OperationContext` (phase 06).
- `pnpm build` against `apps/web/dist` fails with EPERM because another session's `astro preview --port 4326` holds
  the directory open. I did not stop that server. Building to a scratch outDir passes.
- Warning: an unused `eslint-disable` banner in the generated `packages/sdk/src/generated/openapi.ts`. It is
  harmless; to silence it, drop the banner in `scripts/generate-openapi.ts` and regenerate.

## Deviations (edits outside the listed ownership)

- `apps/web/src/components/admin/PageBuilder.tsx` (a phase-02 file). I added `data-webmcp-builder`/`data-page-id`/
  `data-selected-block`/`data-dirty` attributes. I also added a listener for `marketplace:page-draft-changed` that
  reloads the draft when the builder is clean. WebMCP builder tools cannot see the editor state without it.
- The root `vitest.config.ts` projects list now includes `apps/cli/vitest.config.ts` and
  `apps/cli/vitest.node.config.ts`.
- `packages/auth` gains the MCP audience and resources, and `packages/marketplace` gains the `uploadMedia` service,
  which MCP needs. Keeping this logic in services is what lets MCP avoid a separate DB path.
- `packages/api/src/app.ts` security array cast (a type-only fix; the OpenAPI digest is unchanged).
- `apps/web/package.json`: added `@marketplace/mcp`, `@marketplace/webmcp` and `@marketplace/sdk` (workspace).

## Gaps and risks

- An OAuth-issued JWT with the `/mcp` audience is not tested end to end. Resolving it goes through
  `resolveRequestAuth` with the audiences list, and only API-token and device-session bearers are exercised.
- The WebMCP `preview_page` success path is untested. Workerd tests have no `BETTER_AUTH_SECRET`, so the REST preview
  signing is unavailable there. MCP preview in production signs with `BETTER_AUTH_SECRET`.
- The middleware also resolves a page actor for `/mcp`. This duplicates auth work but is harmless.
- The static `/docs/api` route shadows any CMS page with the slug `docs/api`.
- The local D1 has no indexed packages, so the smoke test could not exercise the package-page WebMCP include
  visually. The include is covered by the bundle and by the webmcp unit tests.

## Unresolved questions

- Should the phase 06 owner fix `request-log.ts` (use `console.info`) so that `pnpm verify` goes green end to end?
