# Security and authorization boundaries review

- Branch `dev`, HEAD `80c122c`, 2026-09-29. Review only; no source edits.
- Scope: `packages/auth`, `packages/contracts` (actor, scopes), `packages/api`, `packages/mcp`, `apps/web/src/{middleware*,server/mcp.ts,pages/mcp.ts,pages/.well-known,pages/preview,pages/media}`, plus the login/signup `next` handling (open redirect sweep) and `docs/security-boundaries.md`.
- Tests: `pnpm vitest run packages/auth packages/mcp packages/api`: 7 files, 49 tests, all pass. None of them cover the findings below.

## Findings

### M1 (major): open redirect after sign-in, bypassing `safeNextPath` with a tab or newline. Confidence: high
- `apps/web/src/components/auth/request.ts:63-66`. It is used by `pages/login/index.astro:13`, `pages/signup/index.astro:10` and `components/auth/AuthForm.tsx:28,67`.
- Evidence: the guard only rejects values that start with `//` or `/\`. `?next=/%09/evil.com` decodes to `"/\t/evil.com"` and gets through. WHATWG URL parsing removes ASCII tab and newline characters, so the browser resolves `/\t/evil.com` as `//evil.com`. I checked this in Node: `new URL("/\t/evil.com", "https://market.example").href` gives `https://evil.com/`. `Headers` keeps the tab in `Location` as-is. A signed-in visitor gets a server 302. A visitor who is not signed in is sent there by `window.location.assign` right after entering their password.
- Impact: phishing directly after a real sign-in on the marketplace origin. The same `next` value also becomes GitHub's `callbackURL`.
- Fix: parse the value instead of checking prefixes: `const u = new URL(next, origin); return u.origin === origin ? u.pathname + u.search + u.hash : fallback;`. Also reject `[\x00-\x1f\\]` up front. Add unit cases for `%09`, `%0a`, `/\` and `\/`.

### M2 (major): Cloudflare rate limits can be bypassed by rotating fake credentials. Confidence: high
- `apps/web/src/middleware/rate-limit.ts:44-51`.
- Evidence: the bucket key is a hash of whatever `Authorization` header or session cookie value the client sends. Nothing checks that the credential is valid before it is used as the key. A random `Cookie: better-auth.session_token=<random>` fails `getSession` (`request-auth.ts:121-122`), falls back to `ANONYMOUS_ACTOR`, and the request is served. So every request can get a new bucket on `/api/v1/search`, `/packages?q=`, and all public `/api/v1/*` reads. On `/api/auth/*`, a random `Authorization` value also gets a fresh key. Only Better Auth's own D1 limiter (keyed by IP) still applies there. The fake cookie also makes each request do extra Better Auth work.
- Impact: the "abuse damper" described in the docs (rate-limits section) is ineffective against a scripted client. FTS search is the costly path.
- Fix: key by `cf-connecting-ip` and apply an IP bucket before any credential bucket. Alternatively, move the credential-keyed limit to after auth resolution (API middleware), so only verified credentials get their own budget.

### M3 (major): OAuth or token callers with `account:write` can mint 365-day personal API tokens that survive revocation. Confidence: high
- `packages/marketplace/src/accounts/api-tokens.ts:57-66` together with `packages/auth/src/create-auth.ts:26,147-150`.
- Evidence: `createApiToken` only requires `account:write` and scopes that are a subset of the caller's. `OAUTH_API_SCOPES` offers `account:write` to any client. Dynamic registration is unauthenticated (`allowUnauthenticatedClientRegistration: true`). A consented OAuth client, or a `cmk_` token with `account:write`, can therefore create a `cmk_` token with `expiresInDays` up to 365 (`contracts/src/accounts.ts:7,17`). `revokeOAuthGrant` (`oauth-grants.ts:36-64`) and `revokeApiToken` do not revoke the tokens they created. The consent text for `account:write` says "Change your account, link devices and manage your data" and does not mention minting credentials.
- Impact: a one-hour, revocable delegated grant turns into a year-long credential that does not show up under "OAuth grants". A malicious MCP client registered through DCR only needs one consent click.
- Fix: in `createApiToken`, require `actor.type === "user"` (a session), as `deleteAccount` already does. Otherwise, record `createdByTokenId` and cascade revocation. Also consider removing `account:write` from `OAUTH_API_SCOPES`.

### M4 (major): the admin bootstrap runbook can promote someone who pre-registered the admin address. Confidence: medium
- `docs/operations.md:14-19` together with `packages/auth/src/admin-allowlist.ts:23-26`.
- Evidence: no emails are sent, and email/password sign-up is open. An attacker can register `admin@…` before the real admin does. Better Auth 1.7.6 then refuses to implicitly link the admin's GitHub account (`requireLocalEmailVerified` defaults to true, `oauth2/link-account.ts@v1.7.6`), so the GitHub path fails with `account_not_linked`. The documented fallback is `UPDATE user SET email_verified = 1 WHERE email = …`. That verifies whichever row exists, which is the attacker's row with the attacker's password. `isAdminAccount` then grants every scope.
- Impact: a full admin takeover that depends on a plausible operator step. The docs say verification prevents this ("anyone could register an allowlisted address first"), but the runbook undoes that protection.
- Fix: change the runbook to delete any existing row for the address that was not created by the intended person (check `created_at` and sessions), have the person sign up, then verify. Better: require the operator to confirm by user id rather than by email. Document the `account_not_linked` symptom.

### m1 (minor): preview bearer tokens are written to Workers Logs. Confidence: high
- `apps/web/src/middleware/request-log.ts:47` (`path: context.url.pathname`) and `rate-limit.ts:97`.
- Evidence: previews live at `/preview/<token>`. `page-service.ts:365` states that the token "is a bearer credential and is never written to the audit log", but every request log line records the whole path.
- Impact: anyone who can read logs can open unpublished drafts until the token expires (up to 24 hours).
- Fix: redact the path, e.g. `path.replace(/^\/preview\/[^/]+/, "/preview/:token")`.

### m2 (minor): the MCP body size cap is not enforced. Confidence: high
- `packages/mcp/src/mcp-endpoint.ts:13,52-58`.
- Evidence: `MAX_MCP_BODY_BYTES` is documented as an "upper bound", but when `content-length` is larger than it, `calledTools` returns `[]` and the request continues. Chunked bodies (no length) get `clone().json()`, so they are buffered twice. `upload_media.base64` has no `max` either (`marketplace-tools.ts:286`). This does not bypass authorization: tools are filtered by `toolsForActor`, and services call `requireScope`.
- Fix: return 413 when the length is over the cap or missing on POST, or read the body through a limited reader. Add `.max()` to `base64` (about 7 MB).

### m3 (minor): accepting a publisher invitation only checks an unverified account email. Confidence: high
- `packages/marketplace/src/publishers/publisher-service.ts:221-240`.
- Evidence: `acceptInvitation` compares `invitation.email` with `user.email` but does not check `emailVerified`. Nothing in the system verifies email/password sign-ups. The npm-maintainer claim path, by contrast, requires verification (`package-claims.ts:107`). So the invitation id (shared out of band) is the real credential, not the mailbox.
- Fix: require `emailVerified`, as `checkNpmMaintainer` does, or state in the API and UI that the invitation id is a secret.

### m4 (minor): the OAuth consent screen does not help users spot a spoofed client. Confidence: medium
- `apps/web/src/pages/oauth/consent.astro:38-54`.
- Evidence: the screen shows `client.name` and `client.uri`, and with unauthenticated DCR the registrant chooses both. It shows neither the `redirect_uri` host nor that the client was self-registered and unverified. A client can call itself "ClarkCant Desktop". Combined with M3, this raises the impact of a single consent.
- Fix: show the redirect host, label DCR clients "unverified", and treat first-party client ids separately.

### m5 (minor): account mutations do not accept `Idempotency-Key`. Confidence: high
- `packages/api/src/routes/me.ts:129-134,174-179,193-198` (tokens, publishers, invitations, domains, repositories, claims).
- Evidence: pages, curation, publish and MCP writes accept keys; `/me/*` POSTs do not. A retried `POST /me/tokens` mints a second plaintext token (up to the 50-token cap). The audit trail is present (checked `api-tokens.ts:89`, `oauth-grants.ts:51`, `publisher-service.ts` invite/accept, `package-claims.ts:65`).
- Fix: route `createApiToken` and `createPublisher` through the existing `idempotent(...)` helper.

### m6 (minor): docs disagree with the code. Confidence: high
- `docs/security-boundaries.md:26` says curation goes "through the API or MCP". MCP has no `set_curation_status` tool (`marketplace-tools.ts:188-313`), so hide and reject are REST-only.
- `docs/security-boundaries.md` (CSP section) says Astro sends the policy "as a header". `apps/web/astro.config.ts:34` says it is "emitted as a <meta> tag". One of these is wrong. Confirm with an `E2E_BUILT=1` run and correct the other.
- The `upload_media` description mentions AVIF, but `MEDIA_EXTENSIONS` and `MEDIA_KEY_PATTERN` (`packages/media/src/media-store.ts:25-37`) do not include it.

## Checked and found sound (no action)
- CSRF: `assertSameOriginMutation` runs for every API request that carries credentials. It exempts only safe methods and bearer credentials. `Origin: null` and a missing Origin/Sec-Fetch-Site are rejected. MCP ignores cookies entirely.
- Admin: `isAdminAccount` requires the allowlist and, outside development, a verified email. Session bearers and OAuth tokens never carry `admin` (`request-auth.ts:116,188`, `create-auth.ts:26`). `/admin` pages gate on the `admin` scope. The API and cmk token scopes are the grant intersected with the account's scopes.
- Better Auth 1.7.6 blocks implicit GitHub linking onto an unverified local account, so a squatted address cannot be taken over automatically (only through M4).
- Preview tokens use domain-separated HMAC, verified in constant time, are schema-checked, bounded to 60 s–24 h (`preview_page` input), and bound to a revision that belongs to the page. The route sets `no-store`, `noindex` and `no-referrer`.
- Media: a strict key regex before R2 (no traversal), sandboxed CSP with `default-src 'none'`, and `nosniff`.
- Error bodies: unknown errors become `internal_error` and are not echoed. Config errors name variables, not values.
- Deployed origin comes from `PUBLIC_SITE_URL`, not from `Host`.

## Unresolved questions
1. Is `account:write` over OAuth intended for third-party MCP clients (M3)? This is a product decision.
2. Which is authoritative for CSP delivery on this adapter, header or meta (m6)?

Status: DONE_WITH_CONCERNS
Summary: No blocking issues. There are 4 major findings: an open redirect via tab/newline in `next`, a rate-limit bypass using fake credentials, OAuth or token callers minting long-lived API tokens that survive revocation, and a runbook step that can make an email squatter an admin. There are also 6 minor findings, including preview tokens being written to logs.
