# Architecture

How the marketplace is put together. Related: [security boundaries](security-boundaries.md),
[deployment](deployment.md), [operations](operations.md), [MCP](mcp.md), [CLI](cli.md), and the extension guides
for [blocks](extending-blocks.md), [API routes](extending-api.md) and [indexers](extending-indexers.md).

## Product boundary

- The marketplace **discovers and curates** ClarkCant packages. It stores metadata, review state,
  and editorial content.
- **npm distributes** package code. The marketplace never hosts or serves package tarballs.
- **ClarkCant installs and executes** packages, and owns permission review. A marketplace listing
  never grants a package any capability.

## Runtime

Two Cloudflare Workers share one D1 database, one R2 bucket, and one queue per environment
(`local`, `staging`, `production`; see each app's `wrangler.jsonc`).

| Worker | Role |
| --- | --- |
| `apps/web` | Astro SSR pages, React islands, the `/api/v1` API, `/openapi.json`, `/mcp`, Markdown twins, sitemaps, `llms.txt` |
| `apps/jobs` | Ingest queue consumer, `IndexPackageWorkflow`, npm discovery cron, default-pages cron |

The web Worker produces work (queue messages, Workflow instances); the jobs Worker consumes it.
The jobs Worker deploys first because it owns the Workflow class the web Worker binds to.

The jobs Worker has two cron triggers in every environment (`apps/jobs/wrangler.jsonc`):

| Cron | Work |
| --- | --- |
| `17 */6 * * *` | npm discovery ([indexing](extending-indexers.md#how-packages-arrive)) |
| `*/10 * * * *` (and every other tick) | `ensureDefaultPagesAsSystem`: creates and publishes any missing landing, about and policy page |

Default pages therefore appear on a new environment within ten minutes of the first jobs deploy, with no manual
step. The job goes through the page commands (validation, revisions, publication records) and records each page it
creates and publishes in the audit log as the system actor `jobs.default-pages`. It never changes a page whose slug
already exists, whether edited, published or not. The one exception is a page this job created itself and never
published (still revision 1, no author, no publication), left by an interrupted run; it is published. When every
page exists, a tick costs a single query. The admin "Create default pages" action remains for local use.
`apps/cli` is a separate Node CLI over the public API ([docs/cli.md](cli.md)).

## Layers

```text
interfaces   apps/web pages · packages/api routes · packages/mcp tools · apps/jobs handlers
     |        parse input with contracts, call services, map errors; no SQL
services     packages/marketplace
     |        business rules, queries, transactions (D1 batch), audit, idempotency, indexing
data         packages/db (Drizzle schema + client) · migrations/
shared       packages/contracts (Zod schemas, error codes, manifest mirror, page documents)
```

Supporting packages:

| Package | Role |
| --- | --- |
| `packages/auth` | Better Auth setup, admin allowlist, API tokens, OAuth/device flows |
| `packages/page-engine` | Block registry, page document validation and operations, HTML + Markdown rendering |
| `packages/markdown` | README/Markdown to sanitized HTML (strict allowlist, URL rewriting) |
| `packages/media` | R2 media keys, image sniffing, safe media serving |
| `packages/seo` | Canonical URLs, meta, JSON-LD builders and validator, sitemaps, robots, `llms.txt`, share links, Markdown twins |
| `packages/sdk`, `packages/mcp`, `packages/webmcp` | Typed API client, MCP server, in-page WebMCP tools |

Rules:

- Every interface delegates to `packages/marketplace`. Routes and pages contain no SQL.
- `packages/contracts` has no runtime dependencies beyond Zod, so every layer (and external
  clients) can import it.
- Services receive a `MarketplaceDeps` object (`db`, optional `queue`/`media`, `now`, `ids`)
  instead of reading globals, which keeps them testable against a real D1.
- Errors are `MarketplaceError` values with a stable `code`; the API maps them to HTTP status and
  the `{ error: { code, message, requestId, details? } }` body.
- Runtime vars are validated once per request (`parseRuntimeVars`); misconfiguration fails with
  `configuration_error` without echoing values.

## Request pipeline (web Worker)

`apps/web/src/middleware.ts` runs, in order:

1. `requestLog`: assigns the request id (a well-formed incoming `x-request-id` or a new UUID), writes one
   structured JSON log line per request, and returns the id in `x-request-id`.
2. `securityHeaders`: CSP merge, framing, HSTS and related headers ([security boundaries](security-boundaries.md)).
3. `rateLimit`: per-bucket limits for auth, publish, search and the API.
4. `pageAuth`: resolves the actor (session or API token) and guards `/admin`.

The Hono API (`packages/api`) is mounted under `/api/v1` and keeps its own `x-request-id` handling; the request log
records the API's id when it set one.

## Public discovery surfaces

Each public HTML page has a canonical URL, Open Graph and Twitter tags, JSON-LD, and, where the content has a
Markdown form, a `.md` twin linked with `<link rel="alternate" type="text/markdown">`:

| HTML | Twin | Source |
| --- | --- | --- |
| `/` | `/index.md` | featured and latest packages, categories |
| `/<slug>` (builder pages) | `/<slug>.md` | page engine `renderMarkdown` for the live revision (same as `GET /api/v1/pages/{slug}?format=md`) |
| `/packages/<name>` | `/packages/<name>.md` | package metadata and sanitized README |
| `/categories/<slug>`, `/collections/<slug>` | `.md` | listings |

Machine-readable indexes: `/robots.txt` (indexing allowed only when `ENVIRONMENT=production`), `/sitemap.xml`
(an index of `/sitemap-<segment>.xml` files: pages, categories, collections, packages in pages of 5,000, `PACKAGES_PER_SITEMAP`),
`/llms.txt` (curated navigation) and `/llms-full.txt` (first-party marketplace pages only; never third-party
READMEs). Builders live in `packages/seo`; the routes are thin wrappers in `apps/web/src/pages` over
`apps/web/src/server/site-index.ts`.

Social images: `og:image` uses a package's raster social card or a page's `meta.image` upload when present,
otherwise the static `/og-default.png`. The indexer renders package cards as SVG, and social networks do not
accept SVG, so SVG cards are never advertised. Rasterising cards on the Worker (resvg-wasm) was not adopted: it
adds a large WASM module to the Worker bundle and needs TTF font files the project does not ship.

The share bar (`components/share/ShareBar.astro`) offers Copy URL, Copy as Markdown (the twin), the native Share
sheet, and "Ask ChatGPT/Claude/Gemini". ChatGPT and Claude accept a prefilled prompt in the URL; Gemini does not,
so the prompt is copied and Gemini opens empty. Every action has a manual copy fallback.

## Data

- Drizzle schema in `packages/db/src/schema`, one file per domain. `auth.ts` is generated by the
  Better Auth CLI and must be regenerated, not edited.
- Migrations are drizzle-kit output plus hand-written SQL for what Drizzle cannot express:
  `packages_fts` (FTS5, BM25 ranking) and the category seed. `pnpm migrations:check` fails on drift.
- `package_versions` rows are immutable once written. Public visibility is limited to the
  `listed` and `featured` curation states ([what they mean](security-boundaries.md#curation-and-trust)).
- Multi-statement writes that must be atomic (audit + change, search index refresh) go through
  `db.batch`.
- D1 limits that local SQLite does not enforce: at most 100 bound parameters per statement, 1000 queries per
  invocation, 2 MB per row. Queries that bind an id list split it with `chunked` (`packages/marketplace/src/d1-limits.ts`,
  at most 90 ids); tests run the affected services through a D1 wrapper that fails any statement binding more than 100.
- Draft saves are optimistic: a new revision is numbered `base + 1` from the revision the editor started from, so
  the unique `(page_id, number)` index turns a concurrent save into a `conflict` instead of a lost edit.
- Account deletion keeps media still used by a package preview or by any page revision (draft or published); only
  its owner is cleared. Unreferenced media is deleted from D1 and R2.

## ClarkCant manifest

`packages/contracts/src/manifest.ts` mirrors both manifest dialects ClarkCant accepts: the
install manifest (`clarkcant/packages/contracts/src/install.ts`) and the widget package manifest
(`clarkcant/packages/core/src/widget-package.ts`). `normalizeManifest` maps either into one shape
for indexing. Keep the mirror in sync when ClarkCant changes its contracts.

## Testing

- Vitest runs the `packages/*`, `apps/web` and `apps/cli` projects. Service and API tests run inside workerd
  through `@cloudflare/vitest-pool-workers` with every migration applied to a real D1; nothing mocks the
  database.
- Playwright (`e2e/`) covers the smoke paths plus SEO surfaces, security headers, the share bar, cookie consent,
  axe accessibility and 375px layout. `E2E_BUILT=1` enables the checks that need a production build (the hashed CSP
  and the JavaScript budget): build, run `astro preview`, and point `BASE_URL` at it.
