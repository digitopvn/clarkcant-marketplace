# clarkcant-marketplace

Community discovery and curation marketplace for ClarkCant widgets distributed via npm.

The marketplace discovers and curates packages. npm distributes them. ClarkCant installs and runs
them, and reviews every permission a package asks for.

## Documentation

| Topic | Doc |
| --- | --- |
| How it fits together; discovery surfaces (Markdown twins, sitemaps, `llms.txt`) | [docs/architecture.md](docs/architecture.md) |
| Trust signals and curation meanings, CSP and headers, rate limits, consent | [docs/security-boundaries.md](docs/security-boundaries.md) |
| MCP server for agents | [docs/mcp.md](docs/mcp.md) |
| `clark-market` CLI | [docs/cli.md](docs/cli.md) |
| Deploying, secrets, Cloudflare resources | [docs/deployment.md](docs/deployment.md) |
| Admin bootstrap, migrations, backup, monitoring | [docs/operations.md](docs/operations.md) |
| Adding page blocks, API routes, indexing checks | [blocks](docs/extending-blocks.md), [API](docs/extending-api.md), [indexers](docs/extending-indexers.md) |
| Linking ClarkCant accounts | [docs/clarkcant-account-linking.md](docs/clarkcant-account-linking.md) |

Contributors and coding agents: read [AGENTS.md](AGENTS.md) first.

## Requirements

- Node 24 (`.nvmrc`; Node >= 22.12 works) and pnpm 10.32.1 (`corepack enable`).
- No Cloudflare account is needed for local work: D1, R2, and Queues run locally through wrangler/Miniflare.

## Quick start

```sh
pnpm install
pnpm db:migrate:local   # apply migrations/ to the local D1 database
pnpm dev                # http://localhost:4321
```

Useful URLs: `/`, `/packages`, `/api/v1/health`, `/api/v1/packages`, `/api/v1/search?q=`,
`/api/v1/categories`, `/openapi.json`, `/mcp`, `/llms.txt`, `/sitemap.xml`, and any public page with `.md`
appended (the home page: `/index.md`).

Local overrides for `wrangler.jsonc` vars go in `apps/web/.dev.vars` (see `.dev.vars.example`).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Astro dev server for the web Worker on port 4321 (real local D1) |
| `pnpm dev:jobs` | Jobs Worker (queue consumer, Workflow, cron) on port 8788 |
| `pnpm build` | Build the web Worker and bundle the jobs Worker (dry run) |
| `pnpm verify` | `lint` + `typecheck` + `test` |
| `pnpm lint` / `pnpm typecheck` | ESLint (flat config) / `tsc --noEmit` per package and `astro check` |
| `pnpm test` | Vitest projects; service and API tests run against a real D1 with migrations applied |
| `pnpm test:e2e` | Playwright (smoke, SEO surfaces, headers, share, consent, axe, 375px); starts the dev server, or targets `BASE_URL`. `E2E_BUILT=1` adds the CSP and JavaScript-budget checks against a production build served by `astro preview` |
| `pnpm index:local <name>@<version> --tarball <file.tgz>` | Index a real package tarball into the local database through the production pipeline, without contacting npm |
| `pnpm db:generate` | Generate a migration from the Drizzle schema in `packages/db/src/schema` |
| `pnpm migrations:check` | Fail when the schema has changes without a committed migration |
| `pnpm db:migrate:local` | Apply migrations to the local D1 database |
| `pnpm db:migrate:staging` / `:production` | Apply migrations remotely (CI runs these on deploy) |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after editing a `wrangler.jsonc` |
| `pnpm --filter @marketplace/db auth:schema` | Regenerate the Better Auth tables (`packages/db/src/schema/auth.ts`) |

First-time Playwright setup: `pnpm exec playwright install chromium`.

## Layout

```text
apps/web          Astro SSR Worker: pages, React islands, and the /api/v1 Hono app
apps/jobs         Queue consumer, index Workflow, and discovery cron
packages/contracts  Zod contracts shared by every interface (manifest, API, errors, pages)
packages/db       Drizzle schema and client
packages/marketplace  Application services; the only layer that talks to the database
packages/api      Hono + OpenAPI routes that delegate to marketplace services
packages/auth     Better Auth, admin allowlist, API tokens, OAuth and device flows
packages/page-engine  Block registry, page documents, HTML and Markdown rendering
packages/seo      Canonical URLs, JSON-LD, sitemaps, robots, llms.txt, share links, Markdown twins
packages/markdown README sanitizing
packages/media    R2 media storage and safe serving
packages/sdk, packages/mcp, packages/webmcp  API client, MCP server, in-page WebMCP tools
apps/cli          clark-market CLI
migrations        D1 migrations (drizzle-kit output plus FTS5 and seed SQL)
e2e               Playwright tests
```

## Deployment

Details in [docs/deployment.md](docs/deployment.md). In short: CI deploys `dev` to staging and `main` to production (`.github/workflows/deploy.yml`) after the
same verification CI runs on every branch. Required GitHub configuration: secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and a `SITE_URL` variable on the `staging` and
`production` environments. Set `PUBLIC_SITE_URL` in the matching `env.*.vars` of both
`wrangler.jsonc` files; Workers refuse requests while it is empty.
