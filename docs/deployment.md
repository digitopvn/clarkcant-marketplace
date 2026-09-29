# Deployment

Two Workers per environment (`apps/jobs`, then `apps/web`), deployed by CI. Environments are the `env.staging` and
`env.production` blocks of each app's `wrangler.jsonc`; the top level is local development.

## Pipeline

`.github/workflows/deploy.yml`: `dev` deploys to **staging**, `main` to **production**.

1. Verify: `pnpm verify`, `pnpm migrations:check`, `pnpm build`, Playwright e2e against the dev server.
2. Check configuration (fails fast when a secret or variable below is missing).
3. List, apply, and list again the D1 migrations (`wrangler d1 migrations apply DB --remote --env <env>`).
4. Deploy the jobs Worker first: it owns the `IndexPackageWorkflow` class the web Worker binds to.
5. Build the web Worker with `CLOUDFLARE_ENV=<env>` (selects the wrangler environment at build time) and deploy it.
6. Smoke test `/api/v1/health`, `/openapi.json` and `/`; on staging, run Playwright against the deployed URL.

Deploys happen only through CI. Never deploy from a workstation with `--remote` credentials unless you are
recovering an incident and have recorded why.

## Configuration

GitHub, per environment (`staging`, `production`):

| Name | Kind | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | Workers, D1, R2, Queues edit rights for the account |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Target account |
| `SITE_URL` | variable | Public origin used by the smoke tests |

Worker vars (`wrangler.jsonc`, `env.<env>.vars`): `PUBLIC_SITE_URL` (absolute origin; Workers refuse requests while
it is empty) and `ENVIRONMENT` (`staging` | `production`). `robots.txt` allows indexing only when
`ENVIRONMENT=production`, so staging never competes with production in search results.

Worker secrets, set once per environment with
`pnpm --filter @marketplace/web exec wrangler secret put <NAME> --env <env>`:

| Secret | Required | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | yes | At least 32 random characters (`openssl rand -base64 32`). Also keys preview links; rotating it signs everyone out and invalidates outstanding preview links. |
| `ADMIN_EMAILS` | yes | Comma-separated admin allowlist, compared case-insensitively. Web Worker only; the jobs Worker validates it but makes no admin decisions. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | optional | Enables "Continue with GitHub". Set both or neither. Callback: `<PUBLIC_SITE_URL>/api/auth/callback/github`. |

Local development uses `apps/web/.dev.vars` (names in `.dev.vars.example`), never committed.

## Cloudflare resources

Created once per environment and referenced by name or id in both `wrangler.jsonc` files: the D1 database, the R2
media bucket, the ingest queue and its dead-letter queue. Workflows are created by deploying the jobs Worker.

Rate limiting uses Workers rate-limit bindings declared in `apps/web/wrangler.jsonc` (`ratelimits`). Each
`namespace_id` is an integer chosen by us and must be unique within the account per environment: local uses
`1001`-`1004`, staging `2001`-`2004`, production `3001`-`3004`. Changing a limit is a config change plus deploy.
See [security boundaries](security-boundaries.md#rate-limits) for the buckets.

Observability: `observability.enabled` is set for the web Worker in every environment and at the top level of the jobs Worker config (an inheritable key), so Workers Logs keeps the
structured JSON lines described in [operations](operations.md#monitoring-and-logs).

After editing a `wrangler.jsonc`, run `pnpm cf-typegen` so `worker-configuration.d.ts` matches the bindings.

## Before the first production deploy

- Set the secrets above, then bootstrap an admin ([operations](operations.md#admin-bootstrap)).
- Run "Create default pages" in the admin, then replace every `[TO BE CONFIRMED]` placeholder in the legal pages
  after legal review.
- Confirm `PUBLIC_SITE_URL` is the final origin: canonical URLs, sitemaps, `llms.txt`, Open Graph URLs and
  preview links are all absolute and derived from it.
