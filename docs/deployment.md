# Deployment

Two Workers per environment (`apps/jobs`, then `apps/web`), deployed by CI. Environments are the `env.staging` and
`env.production` blocks of each app's `wrangler.jsonc`; the top level is local development.

## Pipeline

`.github/workflows/deploy.yml`: `dev` deploys to **staging**, `main` to **production**.

1. Verify: `pnpm verify`, `pnpm migrations:check`, `pnpm build`, Playwright e2e against the dev server.
2. Check configuration (fails fast when a secret or variable below is missing).
3. List, apply, and list again the D1 migrations
   (`wrangler d1 migrations apply DB --remote --config wrangler.jsonc --env <env>`).
4. Deploy the jobs Worker first: it owns the `IndexPackageWorkflow` class the web Worker binds to.
5. Build the web Worker with `CLOUDFLARE_ENV=<env>` (selects the wrangler environment at build time) and deploy it.
6. Smoke test `/api/v1/health`, `/openapi.json` and `/`; on staging, run Playwright against the deployed URL with
   `E2E_BUILT=1`, so the hashed-CSP and JavaScript-budget checks run against the real production build.
7. On production only, a separate `release-tag` job pushes a `release-<UTC time>` tag. It is the only job with
   `contents: write`; the deploy job, which runs install scripts next to the Cloudflare token, is read-only.

Deploys happen only through CI. Never deploy from a workstation with `--remote` credentials unless you are
recovering an incident and have recorded why.

### Migrations and the build redirect

`astro build` writes `apps/web/.wrangler/deploy/config.json`, which redirects wrangler to the generated config of
the environment that was built. Wrangler follows it whenever `--config` is absent, so after a local
`CLOUDFLARE_ENV=staging` build a bare `wrangler d1 migrations apply DB --env production` either stops with an
environment-mismatch error or, when the build recorded no target environment, silently uses the built config and
its database. The `pnpm db:migrate:local|staging|production` scripts and the deploy workflow therefore pass
`--config wrangler.jsonc`, which always reads the source config and honours `--env`.

## Configuration

GitHub configuration:

| Name | Kind | Scope | Purpose |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | repository | Workers, D1, R2, Queues edit rights for the account |
| `CLOUDFLARE_ACCOUNT_ID` | variable | repository | Target account id (not sensitive) |
| `SITE_URL` | variable | environment (`staging`, `production`) | Public origin used by the smoke tests and e2e |
| `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` | secret | repository or `staging` environment, optional | Enables the page-builder e2e flow on staging |

An environment secret with the same name overrides the repository secret for jobs in that environment, so a
narrower token can be set on `production` later without changing the workflows.

To enable the page-builder e2e on staging: add the email to the staging Worker's `ADMIN_EMAILS` secret, sign up
with it once on staging and verify the email (outside development, admin requires a verified email), then set
`E2E_ADMIN_EMAIL` and `E2E_ADMIN_PASSWORD` as GitHub secrets. While either is absent, the flow is skipped and the
rest of the suite still runs. The flow creates and publishes a test page in staging data.

### PR previews

`.github/workflows/preview.yml` uploads a version of the **staging** web Worker for each same-repository pull
request (`wrangler versions upload --preview-alias pr-<number>`) and comments its URL. It runs in the `staging`
GitHub environment, so that environment's protection rules apply; if the environment restricts deployment
branches, PR branches must be allowed for previews to run.

- Fork PRs are skipped: they never receive the Cloudflare token.
- Install and build run without the token; only the upload step receives it. PR authors with write access can
  still change what that step runs, which is the same trust they already have by pushing to `dev`.
- A preview uses staging bindings: the staging D1 database, R2 bucket and queue. Its writes are real staging
  writes. Previews never apply migrations, so a PR that touches `migrations/` gets no preview (a comment says so);
  test schema changes on staging after merging to `dev`.
- Uploading a version does not deploy it; staging traffic stays on the deployed version.

Worker vars (`wrangler.jsonc`, `env.<env>.vars`): `PUBLIC_SITE_URL` (absolute origin; Workers refuse requests while
it is empty) and `ENVIRONMENT` (`staging` | `production`). `robots.txt` allows indexing only when
`ENVIRONMENT=production`, so staging never competes with production in search results. The web Worker also has
`CF_WEB_ANALYTICS_TOKEN`, the public Cloudflare Web Analytics site token (empty disables analytics). Staging and
production share the token of the `clarkcant.cc` zone site, set to "Enable with JS Snippet installation"; the
beacon loads only after a visitor opts in to analytics ([consent](security-boundaries.md#cookies-and-consent)). Keep
Web Analytics automatic injection turned off for these hostnames in the dashboard: an injected beacon would run
without consent. HTML pages also send `Cache-Control: no-transform`, which stops the edge from injecting it (and from
any other rewriting) even when the zone setting is on; the Worker compresses those pages itself
(`apps/web/src/middleware/edge-transform-opt-out.ts`).

Domains: the web Worker is served on Workers Custom Domains in the `clarkcant.cc` Cloudflare zone,
`staging.marketplace.clarkcant.cc` (staging) and `marketplace.clarkcant.cc` (production), declared as `routes` with
`custom_domain: true` in `apps/web/wrangler.jsonc`. Deploying creates the DNS record and certificate, so the deploy
token needs Workers Routes and DNS edit on that zone. `PUBLIC_SITE_URL` in both `wrangler.jsonc` files and the
`SITE_URL` environment variable must name the same origin. Changing the origin signs everyone out and invalidates
passkeys, because Better Auth trusts only that origin and uses its hostname as the passkey RP ID.

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
