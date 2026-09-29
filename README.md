# clarkcant-marketplace

Community discovery and curation marketplace for ClarkCant widgets distributed via npm.

The marketplace discovers and curates packages. npm distributes them. ClarkCant installs and runs
them, and reviews every permission a package asks for. See [docs/architecture.md](docs/architecture.md).

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
`/api/v1/categories`, `/openapi.json`.

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
| `pnpm test:e2e` | Playwright smoke; starts the dev server, or targets `BASE_URL` when set |
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
migrations        D1 migrations (drizzle-kit output plus FTS5 and seed SQL)
e2e               Playwright smoke tests
```

## Deployment

CI deploys `dev` to staging and `main` to production (`.github/workflows/deploy.yml`) after the
same verification CI runs on every branch. Required GitHub configuration: secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and a `SITE_URL` variable on the `staging` and
`production` environments. Set `PUBLIC_SITE_URL` in the matching `env.*.vars` of both
`wrangler.jsonc` files; Workers refuse requests while it is empty.
