# Operations

Running the marketplace day to day. Commands assume the repository root; `<env>` is `staging` or `production`.
Remote commands (`--remote`) change live data: run them deliberately and record why.

## Admin bootstrap

Admin rights come from the `ADMIN_EMAILS` secret, and outside development only for a **verified** email
([why](security-boundaries.md#accounts-and-admin)). There is no email sender yet, so an address becomes verified in
one of two ways:

1. **GitHub sign-in** (when `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are set): sign in with a GitHub account whose
   verified primary email is on the allowlist. If this fails with `account_not_linked`, an email/password account
   already exists for that address. It may not be the admin's: see the warning below before doing anything else.
2. **Operator verifies one specific account, by user id**, after the person signed up with email and password.

> **Pre-registration squatting.** Sign-up is open and no email is sent, so anyone can register the admin address
> before the admin does, with their own password. Verifying "the row with this email" would hand that stranger
> every admin scope. Never verify by email alone; identify the account by its id and confirm the admin created it.

Procedure for step 2:

1. The person signs up, then opens `/api/v1/me` while signed in and sends you its `id`, together with roughly when
   they signed up, over a channel you already trust (not an email to the address being verified).
2. Look up every account for the address, how it signs in and where its sessions come from:

   ```sh
   pnpm --filter @marketplace/web exec wrangler d1 execute DB --remote --env <env> --command \
     "SELECT id, email_verified, datetime(created_at / 1000, 'unixepoch') AS created FROM user WHERE email = lower('admin@example.com')"
   pnpm --filter @marketplace/web exec wrangler d1 execute DB --remote --env <env> --command \
     "SELECT provider_id, datetime(created_at / 1000, 'unixepoch') AS created FROM account WHERE user_id = '<user id>'"
   pnpm --filter @marketplace/web exec wrangler d1 execute DB --remote --env <env> --command \
     "SELECT datetime(created_at / 1000, 'unixepoch') AS created, ip_address, user_agent FROM session WHERE user_id = '<user id>'"
   ```

3. Continue only if there is exactly one row, its `id` is the one the person sent, `created` matches when they
   signed up, and its sign-in methods and sessions are all theirs. If the row predates their sign-up or they do not
   recognise it, it is squatted: do not verify it. Free the address and end its sessions, keeping the row for the
   audit trail, then have the person sign up again and start over:

   ```sh
   pnpm --filter @marketplace/web exec wrangler d1 execute DB --remote --env <env> --command \
     "UPDATE user SET email = 'squatted-' || id || '@invalid' WHERE id = '<squatter id>'; DELETE FROM session WHERE user_id = '<squatter id>'"
   ```

4. Verify by id, with the address as a second guard (the command changes nothing if either does not match):

   ```sh
   pnpm --filter @marketplace/web exec wrangler d1 execute DB --remote --env <env> --command \
     "UPDATE user SET email_verified = 1 WHERE id = '<user id>' AND email = lower('admin@example.com')"
   ```

The person then signs out and in again so the new session carries the verified address; the stored `role` column
mirrors the allowlist at each new session. To revoke, remove the address from `ADMIN_EMAILS`
(`wrangler secret put ADMIN_EMAILS --env <env>`); admin checks read the allowlist on every request.

## Secrets

`BETTER_AUTH_SECRET` (required), `ADMIN_EMAILS` (required), `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (optional,
both or neither). How to set them and what rotating `BETTER_AUTH_SECRET` does: [deployment](deployment.md#configuration).

## First content

- **Default pages**: the admin's "Create default pages" creates and publishes the landing, about and legal pages
  (Terms, Privacy, Cookies, Refunds, GDPR, Security, Subprocessors) when missing, never overwriting existing ones.
  The legal pages are drafts with `[TO BE CONFIRMED]` placeholders until legal review replaces them.
- **Packages** arrive through the discovery cron, publisher submissions, or `pnpm index:local` in development
  ([indexing](extending-indexers.md)).

## Curation

| Status | Meaning |
| --- | --- |
| `listed` | Passed automated checks (manifest, integrity) when indexed; **not human-reviewed**. Default for indexed packages. |
| `featured` | Chosen by curators; the only curated signal. |
| `hidden` | Removed from public surfaces, for example pending a question to the publisher. |
| `rejected` | Removed from public surfaces permanently. |

Change status through the REST API (`POST /api/v1/curation/packages/{name}/status`, scope `packages:curate`, which
admins hold); MCP can only feature or unfeature (`feature_package`). Every change is audited. npm provenance
is recorded when present, **not verified**. Say so whenever you describe a package publicly.

## Migrations discipline

- Change the Drizzle schema in `packages/db/src/schema`, then `pnpm db:generate`. Hand-write SQL only for what
  Drizzle cannot express (FTS5, seeds) and keep it in `migrations/`.
- `pnpm migrations:check` (CI) fails when the schema and committed migrations differ.
- Migrations are forward-only and additive: add columns and tables; do not drop or rename in the same release that
  stops using them. A destructive step ships in a later release, after a backup point.
- Never edit an applied migration. Fix forward with a new one.
- Apply locally with `pnpm db:migrate:local`; CI applies remotely before deploying code, so code must work with both
  the old and new schema during a deploy.
- `package_versions` rows are immutable; a migration must not rewrite them.

## Backup and recovery

**D1** has Time Travel: point-in-time restore to any minute in the retention window (30 days on Workers Paid,
7 days on Free).

```sh
# Find the bookmark for a moment before the incident
pnpm --filter @marketplace/web exec wrangler d1 time-travel info DB --env <env> --timestamp 2026-01-31T12:00:00Z
# Restore the whole database to it (this replaces current data)
pnpm --filter @marketplace/web exec wrangler d1 time-travel restore DB --env <env> --bookmark <bookmark>
```

Before a risky operation, note the current bookmark (`time-travel info` without a timestamp) and export a copy:
`wrangler d1 export DB --remote --env <env> --output backup.sql`. Keep exports out of the repository: they
contain account data.

**R2** holds media under content-addressed keys (a key's bytes never change), so objects are never overwritten.
R2 has no point-in-time restore: copy the bucket to a second bucket or storage (for example `rclone sync` with an
R2 API token) on a schedule if media must survive deletion. Package media can be regenerated by re-indexing; page
uploads cannot.

After a D1 restore, media referenced by restored rows still exists (unreferenced media is deleted only when nothing
refers to it), and search is consistent because the FTS table lives in D1.

## Monitoring and logs

- **Health**: `GET /api/v1/health` checks a database round-trip and returns `503` when it fails. CI smoke-tests it
  on every deploy; point an uptime monitor at it.
- **Logs**: Workers Logs (dashboard, Workers > the Worker > Logs) or `wrangler tail --env <env>` live. The web Worker
  writes one JSON line per request:

  ```json
  {"level":"info","event":"request","requestId":"…","method":"GET","path":"/packages","status":200,"durationMs":41}
  ```

  plus `request_failed` (unhandled errors, with the request id), `rate_limited`, `rate_limit_binding_missing` and
  `rate_limit_check_failed`. Query strings are never logged. Filter by `requestId` to join a user report (every
  response carries `x-request-id`) to its logs.
- **Indexing**: failed submissions keep their rejection code (`GET /api/v1/publish/submissions/{id}`); messages that
  exhaust retries land in the ingest dead-letter queue. Workflow runs are visible in the dashboard
  (Workers > Workflows).
- **Alerts worth setting**: health not 200, a rise in `request_failed` or 5xx, any `rate_limit_binding_missing`,
  and a non-empty dead-letter queue.
- **Jobs CPU budget**: `apps/jobs/wrangler.jsonc` pins `limits.cpu_ms` to 30000 in every environment (Workers Paid
  allows up to 300000), because README rendering and tarball parsing run in that Worker. If indexing logs show
  `exceededCpu`, raise it there rather than shrinking the README size limits.

## Known limitations

- Search sync (`packages/marketplace/src/search/search-index.ts`) deletes a package's old `packages_fts` row by its
  unindexed `package_id` column, which scans the whole FTS table on every sync. It is cheap at the current catalogue
  size; fixing it needs a package-to-FTS rowid mapping table and a migration (`packages.rowid` can change on VACUUM).

## Local development

`pnpm dev` (port 4321), `pnpm dev:jobs`, `pnpm db:migrate:local`, and
`pnpm index:local <name>@<version> --tarball <file.tgz>` to index a real tarball into the local database without
contacting npm. See the [README](../README.md#commands).
