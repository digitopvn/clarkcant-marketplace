# Phase 04 — Auth, accounts, publishers (M2 + account lifecycle)

Status: completed (2026-09-29) · Wave 2 (parallel with 02, 03) · Depends on 01. Report: `plans/reports/fullstack-developer-260929-2015-phase-04-auth.md`.

## Owns (only these files)
- `packages/auth/**` (new): per-request Better Auth factory (Drizzle adapter on D1), plugins, actor resolution,
  scope model, API tokens, rate-limit helper for auth.
- `packages/marketplace/src/publishers/**`, `src/accounts/**` (+ tests).
- `packages/api/src/routes/me.ts`, `packages/api/src/middleware/**` (actor/auth/scope/CSRF middleware that sets
  `c.set('actor', …)` for ALL routes), `apps/web/src/pages/api/auth/[...all].ts`.
- `apps/web/src/pages/{login,signup,account,device,oauth}/**`, `apps/web/src/components/auth/**`,
  `apps/web/src/middleware.ts` (session → locals.actor; admin route guard for `/admin/**`).

## Requirements
- Better Auth 1.7.6: email+password, GitHub social (enabled only when GITHUB_CLIENT_ID/SECRET present — UI shows
  honest disabled state otherwise), passkey (`@better-auth/passkey`), organization plugin (publishers = orgs with
  members/roles owner|admin|member), deviceAuthorization (CLI login), bearer where needed, jwt + `@better-auth/oauth-provider`
  (OAuth 2.1/OIDC groundwork: discovery endpoints, PKCE, login + consent pages) for ClarkCant desktop and MCP clients.
  Secrets: BETTER_AUTH_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET via `.dev.vars` / wrangler secrets (names only in examples).
- Admin: `ADMIN_EMAILS` (comma list) → role admin on sign-in/lookup; admin gets `admin:*`.
- Actor model (contracts): `{ type: 'anonymous'|'user'|'token', userId?, scopes: Scope[] }`. Scopes: pages:read,
  pages:write, pages:publish, packages:submit, packages:curate, media:write, account:read, account:write, admin:*.
  Normal user: account:*, packages:submit. Admin: all. Tokens: subset of the creator's scopes.
- API tokens: create/list/revoke (`/api/v1/me/tokens`), hashed (SHA-256) at rest, prefix `cmk_`, shown once, expiry,
  last_used. Accepted as `Authorization: Bearer` by API + MCP. Device authorization flow returns a session usable as bearer
  (document which). No raw admin token for agents; agents get scoped tokens.
- Middleware: CSRF protection for cookie-authenticated mutations (Origin check), rate limiting for auth endpoints
  (use Cloudflare Rate Limiting binding if available in wrangler, else D1/cache-based fixed window — document).
- Publishers: create publisher (org), invite/list members, link verified domains (DNS TXT challenge record stored;
  verification check command), link repositories, claim package (`package_claims`: proves control via npm
  maintainers list or repository match — record method). Package ownership belongs to publisher, not an email.
- ClarkCant account link contract: `POST /api/v1/me/devices/link` (OAuth PKCE-authenticated ClarkCant client registers
  `{ localPrincipalId: prin_*, deviceLabel }`), list, unlink. Local identity is never replaced; link is optional.
  Document the flow in `docs/clarkcant-account-linking.md`.
- `/api/v1/me`, `/api/v1/me/packages` (packages of the user's publishers), `/api/v1/me/export` (JSON of all user
  data), `DELETE /api/v1/me` (delete account + profile, revoke tokens/oauth grants, unlink devices, remove owned media
  records + R2 objects via media port; audit), revoke OAuth clients/consents.
- Web: sign in / sign up / account page (profile, passkeys, linked devices, tokens, publishers, export, delete),
  device verification page, OAuth consent page. Brand tokens from phase 01.

## Acceptance
- Tests: scope checks, token hashing/verification/revocation, admin allowlist, CSRF rejection, publisher membership
  rules, device link/unlink, export contents, deletion cascade.
- Local: sign up → sign in → create token → call `/api/v1/me` with bearer → admin gating on `/admin` works.
- `pnpm verify && pnpm build` green.
