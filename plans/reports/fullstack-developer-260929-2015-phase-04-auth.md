# Phase 04: auth, accounts, publishers (implementation report)

Plan: `plans/260929-1909-gh1-marketplace-bootstrap/phase-04-auth-accounts.md`. Status: completed.
Nothing was committed, pushed, deployed or sent to a remote.

## What was built

- **Better Auth 1.7.6:** a per-request factory using the Drizzle adapter on D1. It enables:
  - email and password sign-in;
  - GitHub sign-in, only when both GitHub secrets are set;
  - passkeys and the organization plugin (publishers are orgs);
  - device authorization, bearer and jwt;
  - `@better-auth/oauth-provider` with discovery, PKCE, dynamic client registration and login/consent pages.
- **Actor model in contracts** (`actor.ts`): anonymous, user or token. It covers scope sets per account and the helpers `requireScope`, `requireUser` and `actorHasScope`. The scope `packages:curate` was added.
- **Actor middleware:** registered in the app factory for `/api/v1/*`. It sets `c.var.actor` on every route and enforces the CSRF Origin check on cookie-authenticated mutations.
- **Services** (`packages/marketplace/src/{accounts,publishers}`):
  - API tokens: `cmk_` prefix, SHA-256 hash at rest, shown once, expiry, throttled `last_used`, at most 50 active.
  - Device links for ClarkCant principals.
  - Profile, owned packages and data export.
  - Account deletion as a D1 batch that cascades, removes media through `@marketplace/media`, and writes an audit event.
  - OAuth grant list and revoke.
  - Publishers: create, members, invitations, DNS TXT domain verification, repository verification, and package claims via npm maintainers or a repository match.
- **REST endpoints** (`routes/me.ts`, in OpenAPI):
  - `/me`, `DELETE /me`, `/me/packages`, `/me/export`
  - `/me/tokens`, `/me/devices/link`, `/me/devices`, `/me/oauth/grants`
  - `/me/publishers/**`, `/me/invitations/{id}/accept`
- **Web:**
  - Pages: `/login`, `/signup`, `/account`, `/device`, `/oauth/consent`.
  - React islands in `components/auth/` use brand tokens.
  - `middleware.ts` puts the session into `locals.actor`. On `/admin/**` it redirects anonymous visitors to `/login` and answers 403 to signed-in accounts without admin.
- **Rate limiting:** stored in D1 by Better Auth (the `rate_limit` table from migration 0004). Wrangler has no rate-limit binding.
  - Default: 120 requests per 60 s.
  - Stricter windows: sign-in 10/min, sign-up 10/h, device code 10/min, OAuth registration 20/h, passkey auth 20/min.

## File map (created unless marked edited)

- **contracts:** `src/actor.ts`, `src/accounts.ts`, `src/publishers.ts`. Edited: `src/scopes.ts`, `src/index.ts`.
- **auth:** `src/{create-auth,request-auth,admin-allowlist,csrf,secrets,client,index}.ts` and `test/auth-flows.test.ts`. Edited: `package.json` (dependency and the `./client` export).
- **marketplace:**
  - `src/accounts/{api-tokens,device-links,account-service,account-deletion,oauth-grants}.ts`
  - `src/publishers/{publisher-service,publisher-verification,package-claims,verification-ports}.ts`
  - `test/{accounts,publishers}.test.ts`, `test/support/accounts.ts`
  - Edited: `src/index.ts` (appended exports).
- **api:** `src/middleware/actor.ts`, `src/routes/me.ts`, `test/me.test.ts`. Edited: `src/app.ts` (one `app.use` line), `src/types.ts` (`actor`, `resolveAuth`), `package.json`.
- **db:** edited `scripts/auth-schema.config.ts` and `src/schema/auth.ts` (regenerated; adds `rate_limit`). Added `migrations/0004_auth_rate_limit.sql` plus meta (approved by the controller).
- **web:**
  - `src/middleware.ts`, `src/pages/api/auth/[...all].ts`
  - `src/pages/{login,signup,account,device}/index.astro`, `src/pages/oauth/consent.astro`
  - `src/components/auth/*` (7 files)
  - Edited: `package.json` and `.dev.vars.example` (names only).
- **Outside my ownership list:** see Deviations.
- **docs:** `docs/clarkcant-account-linking.md`.

## Auth flows

How a request is authenticated. An `Authorization` header takes precedence over the cookie. A bad bearer gets a 401 and never falls back to anonymous.

- **Browser:** the session cookie from `/login` gives the account's full scopes. Mutations must come from the same origin (`Origin`, or `Sec-Fetch-Site: same-origin`); otherwise the response is 403 `csrf_origin_mismatch`.
- **Personal token:** `Bearer cmk_…` is created on the account page or with `POST /api/v1/me/tokens`. Its scopes are the ones granted, intersected with the account's current scopes. This is the recommended credential for agents and CI.
- **CLI (device flow, RFC 8628):**
  1. `POST /api/auth/device/code {client_id: "clark-market-cli" | "clarkcant-desktop"}`.
  2. The user opens `/device?user_code=…`. The page claims the code for the signed-in session, then approves or denies.
  3. The CLI polls `POST /api/auth/device/token` no faster than every 5 s and receives `access_token`.
  4. That token is a **Better Auth session token**. It is used as `Authorization: Bearer`, lasts 7 days (sliding), and carries the account's scopes without `admin`.
- **MCP and desktop (OAuth 2.1 + PKCE):**
  - Discovery is at `/api/auth/.well-known/openid-configuration`; the issuer is `<origin>/api/auth`.
  - Clients register with RFC 7591 at `/api/auth/oauth2/register`. Loopback redirects need `application_type: "native"`.
  - The flow runs authorize, then `/login`, then `/oauth/consent`, then token, with `resource=<origin>/api/v1`.
  - The resulting JWT access token becomes a token actor (`oauth:<clientId>`) whose scopes are the granted scopes. It never carries `admin`.
- **Admin:** the account's email must be in `ADMIN_EMAILS`. Outside development, the email must also be verified. The role is synced on every new session and on every lookup, so removing an email demotes the account.

## Secrets and configuration

- **Wrangler secrets (staging and production):**
  - `BETTER_AUTH_SECRET`: required, at least 32 characters.
  - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: optional, and must be set together. The callback is `<PUBLIC_SITE_URL>/api/auth/callback/github`.
  - `ADMIN_EMAILS`.
- **Local:** `apps/web/.dev.vars` was created with `umask 077`. It is git-ignored (verified with `git check-ignore`). It holds a random 62-character secret (never printed) and `ADMIN_EMAILS=admin@localhost.test`.
- **Validation:** missing or invalid secrets produce `configuration_error` naming the variables, never their values.

## Test evidence

- **Unit and integration** (vitest-pool-workers, real D1 and R2):
  - `packages/auth`: 9/9. Covers secrets, allowlist and demotion, bearer rejection, the token cap and revoke, CSRF, the full device flow, OIDC discovery, and a full OAuth PKCE flow.
  - `packages/marketplace` accounts and publishers: 20/20. Covers scopes, token hash/verify/revoke/expiry, device link/unlink, export contents, the deletion cascade, membership rules, domain and repository verification, and claims.
  - `packages/api` `me.test.ts`: 6/6 over HTTP. Covers 401s, the admin profile, CSRF 403, token then bearer `/me`, scope denial, revoke, devices, publishers and export, and account deletion (media row and R2 object removed, session ended).
- **Full suite `pnpm test`:** 189 passed, 1 failed, 3 skipped. The failure is `api.test.ts` "OpenAPI covers every public route": an expected phase 03 catalog path is missing while phase 03 is still in progress. That is not my code.
- **Lint:** my files are clean. The only lint rule I suppressed is `no-namespace`, for Astro's `App.Locals` augmentation, with a comment explaining why. The remaining `pnpm lint` errors are in phase 02 and 03 files: `indexing/manifest-validation.ts`, `indexing/social-card.ts` and `page-engine/blocks/shared.ts`.
- **Typecheck:** root, auth, api and my web files are clean. The remaining errors:
  - `apps/web/src/pages/preview/[token].astro:22` (phase 02).
  - `packages/marketplace/test/curation-and-submissions.test.ts:70` uses the nonexistent scope `profile:read` (phase 03).
- **Production bundle (`pnpm build`, run through the wrapper script):** web and jobs both completed.
- **Local acceptance** on `astro dev --port 4324` against the migrated local D1:
  - Anonymous `/admin` → 302 to `/login?next=%2Fadmin`.
  - Sign-up for the admin and user accounts → 200. Sign-in → 200.
  - `/admin` as user → 403. As admin → passes the guard (404 only because phase 02's admin page does not exist yet).
  - The token was created from the cookie session. `GET /api/v1/me` with that bearer → the user with `[account:read]`.
  - Cross-origin cookie POST → 403.
  - Device flow end to end, then `/me` with the device bearer (no admin), then a device link → 200.
  - Consent page shows the invalid-client state; anonymous consent → `/login` with the query kept.
  - The GitHub button shows the "not configured" state.
  - The server was stopped afterwards and port 4324 is free.

## Deviations and gaps

- **Files outside my ownership list** (needed for wiring; all small):
  - `apps/web/src/server/auth.ts` (new): builds the runtime from Worker env and reads the secrets by name.
  - `apps/web/src/server/api.ts`: passes `resolveAuth` to `createApi`.
  - `packages/api/src/{app,types}.ts`: middleware registration and types.
  - `packages/marketplace/src/index.ts`: exports.
  - The api, auth and web `package.json` files: workspace dependencies.
  - `apps/web/.dev.vars.example`: names only.
- **Publisher routes** live under `/api/v1/me/publishers/**`, because `routes/me.ts` is the only route file I own. Public publisher pages are not built.
- **Invitations send no email** (there is no mail port). The owner shares the invitation id, and the invitee accepts it on `/account`. The email must match.
- **No domain-verification CLI command.** The "check" is the API and UI action `POST …/domains/{id}/verify`, which does a DNS-over-HTTPS TXT lookup through Cloudflare.
- **Root RFC 8414 path not mounted.** `/.well-known/oauth-authorization-server` and the protected-resource metadata at the site root are not mounted, because those files are not mine. Discovery works under the issuer path. MCP clients that probe only the root path will need a small route; that belongs to whoever owns the MCP/root routes.
- **Header account link:** `SiteHeader.astro` (not mine) has no Sign in or Account link yet.
- **Staging admin access** requires a verified email: GitHub sign-in, or an operator setting `email_verified` in D1. There is no email-verification mailer yet.
- **Local secrets in the bundle output:** the Cloudflare Vite plugin copies `.dev.vars` into `apps/web/dist/server/.dev.vars` for local preview. That directory is git-ignored and is not uploaded as secrets.

## Unresolved questions

1. Who adds the root `/.well-known/oauth-authorization-server` and `oauth-protected-resource` routes for MCP clients?
2. Should `SiteHeader` get Sign in and Account links, and in which phase?
3. Staging admin access needs a verified email. Should we enable GitHub sign-in in staging, or add an email-verification sender?

Status: DONE_WITH_CONCERNS
Summary: Phase 04 auth, accounts, publishers, device links, pages and middleware are built; the 35 phase tests pass, local acceptance passes on port 4324, and `pnpm build` is green.
Concerns: `pnpm verify` is still red from phase 02 and 03 in-progress files (lint in indexing and page-engine, typecheck in `preview/[token].astro` and `curation-and-submissions.test.ts`, the OpenAPI path assertion). I made small wiring edits outside my ownership list, listed under Deviations.
