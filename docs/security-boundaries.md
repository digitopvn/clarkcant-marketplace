# Security boundaries

What the marketplace protects, where each boundary is enforced, and what the public trust signals mean. Code is the
authority; each section names the owning file.

## Threat model in one paragraph

The marketplace stores package metadata, sanitized READMEs, editorial pages, accounts (Better Auth), hashed API
tokens and audit records. It never hosts or runs package code: npm distributes it and ClarkCant installs it and
reviews its permissions. The main risks are therefore content injection (READMEs, uploads, page content), account
and admin takeover, abuse of write and search endpoints, and misleading trust signals.

## Curation and trust

The meanings below are shown in the UI, in `llms.txt` (`TRUST_NOTES` in `apps/web/src/server/site-index.ts`) and on
the package page. Keep all three in step.

| Signal | Meaning | Does **not** mean |
| --- | --- | --- |
| `listed` | Passed automated checks when indexed: manifest validation and npm tarball integrity (sha512). This is the starting state of every indexed package. | Reviewed by a person, or safe to run |
| `featured` | Chosen by marketplace curators | A security audit |
| `hidden`, `rejected` | Removed from every public surface (pages, API, search, sitemaps, `llms.txt`) | Deleted; the record and audit trail stay |
| Verified publisher | Proved control of a web domain with a DNS TXT record | Anything about code quality |
| npm provenance | Recorded when the registry reports it (attestation and signature key ids) | Verified by the marketplace. **Provenance is recorded, not verified.** |

Curation status changes (list, hide, reject, feature) go through the REST API with the `packages:curate` scope
(admins hold every scope) and are audited; MCP can only feature or unfeature (`feature_package`) and manage
collections. There is no curation admin UI yet.

## Content that comes from outside

- **READMEs** are rendered by `packages/markdown` with a strict sanitize allowlist and URL rewriting; raw HTML
  that is not allowlisted is dropped. `llms-full.txt` never includes third-party READMEs.
- **Media** (package previews, page uploads) is stored in R2 under content-addressed keys and served by
  `packages/media` with `Content-Security-Policy: default-src 'none'; …; sandbox` and `nosniff`, so a crafted file
  cannot run script on the site origin. Image types are sniffed from bytes, not trusted from names.
- **Page documents** are validated by `packages/page-engine` (`validatePageDocument`); each block parses its props
  with its own Zod schema on every render and escapes output.
- **JSON-LD** is serialised with `jsonForScript`, which escapes `<`, so no value can close the script element.

## Accounts and admin

- Sessions and OAuth/device flows: `packages/auth` (Better Auth). Auth endpoints are also rate limited by Better
  Auth's own D1-backed limiter (migration 0004).
- Admin rights come only from the `ADMIN_EMAILS` allowlist and, outside development, only for a **verified**
  email (`packages/auth/src/admin-allowlist.ts`). Without the verification rule anyone could register an
  allowlisted address first. See [operations](operations.md#admin-bootstrap) for bootstrapping.
- API tokens are 256-bit random values stored only as SHA-256 hashes (`packages/marketplace/src/accounts/api-tokens.ts`).
  Creating or revoking one needs a signed-in session, never a token (`packages/api/src/routes/me.ts`): a `cmk_` or
  OAuth token cannot turn itself into a credential that outlives its own grant. A retried create with the same
  `Idempotency-Key` answers `409` naming the token instead of storing or repeating its plaintext.
- OAuth clients register themselves without an account, so they are never offered `admin` or `account:write`
  (`OAUTH_API_SCOPES` in `packages/auth/src/create-auth.ts`); account changes stay with sessions. The consent
  screen marks every client as unverified and shows its client id and the host the answer is sent to, because a
  client chooses its own display name and nothing checks it.
- Clients that link a ClarkCant install (e.g. ClarkCant desktop) request `devices:link` instead. It allows only
  linking, listing and unlinking the caller's own device links (`packages/marketplace/src/accounts/device-links.ts`);
  it cannot mint or revoke tokens, revoke grants, read or change the profile, or manage publishers. Sessions and
  `cmk_` tokens holding `account:write` (or `account:read` for listing) keep working for the same routes.
- Publisher invitations can only be accepted by an account whose email is verified. No email is sent, so an
  unverified address proves nothing about the mailbox.
- After sign-in, `?next=` is followed only when it resolves to a path on the site itself
  (`safeNextPath` in `apps/web/src/components/auth/request.ts`); control characters and backslashes are refused.
- Draft previews (`/preview/<token>`) use an HMAC token over page, revision and expiry keyed by
  `BETTER_AUTH_SECRET`; they are `noindex`, `no-store` and `Referrer-Policy: no-referrer`. The token is a bearer
  credential, so request and rate-limit logs record the path as `/preview/:token`.

## Response headers

Set on every response by `apps/web/src/middleware/security-headers.ts`:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | See below |
| `X-Frame-Options` / `frame-ancestors` | `DENY` / `'none'` everywhere; `SAMEORIGIN` / `'self'` only for `/preview/*` (the builder frames previews) |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` (HTTPS only) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` unless the route chose a stricter one |
| `Permissions-Policy` | camera, microphone, geolocation, payment, USB and similar features disabled |
| `Cross-Origin-Opener-Policy` | `same-origin` |

**CSP.** Pages use Astro's hashed policy (`security.csp` in `apps/web/astro.config.ts`), which Astro sends as a
`Content-Security-Policy` response header on this adapter (checked on staging), not a `<meta>` tag: scripts only from `'self'` plus hashes of inline scripts, styles from `'self'`, Google Fonts
and hashes of inline `<style>` elements; `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. The
middleware adds the header-only directives (`frame-ancestors`, `upgrade-insecure-requests`) without overriding what
Astro set (`mergeCsp`). Non-HTML responses get `default-src 'none'`. Inline content Astro does not hash itself:

- inline scripts (the theme script in `BaseLayout.astro`, the builder canvas script) are hashed at request time
  through `Astro.csp.insertScriptHash` (`apps/web/src/server/csp.ts`);
- fixed inline styles (page-engine block styles, the builder canvas stylesheet) are hashed at build time in
  `astro.config.ts`, because runtime style-hash inserts do not reach the policy on Astro 7.3.

`style` attributes are allowed (`style-src-attr 'unsafe-inline'`); they cannot load or run anything. The CSP is not
active under `astro dev`; `E2E_BUILT=1` Playwright runs check a production build for violations.

## Rate limits

`apps/web/src/middleware/rate-limit.ts` uses Cloudflare Workers rate-limit bindings (`ratelimits` in
`apps/web/wrangler.jsonc`, per location, per 60 seconds):

| Bucket | Routes | Limit |
| --- | --- | --- |
| auth | `/api/auth/*` | 60 |
| publish | non-GET `/api/v1/publish/*` | 10 |
| search | `/api/v1/search`, `?q=` on `/api/v1/packages` and `/packages` | 60 |
| api | other `/api/v1/*`, `/openapi.json`, `/mcp` | 300 |

Callers are keyed by client IP (`CF-Connecting-IP`), whether or not they send a credential. The limiter runs before
authentication, so a credential it could see is unverified; keying on it would let a client rotate random tokens or
cookies to get a fresh budget per request. Callers behind one IP (NAT, CI egress) share a budget. A limited request gets
`429` with `Retry-After: 60` and the standard error body (`code: "rate_limited"`). A missing or failing binding fails
open and logs `rate_limit_binding_missing` or `rate_limit_check_failed` at error level; each rejection logs
`rate_limited`. Cloudflare's limiter is itself approximate and per location, so treat these as abuse
dampers, not quotas.

## Cookies and consent

Only first-party cookies are used: the Better Auth session (essential) and `cc_consent` (the visitor's choice,
180 days). The only optional storage is the theme preference in `localStorage`, written only after "Allow
preferences" and erased when preferences are declined (`components/consent/`). There are no analytics or
advertising cookies, so there is no analytics category. Adding any non-essential tracking requires a new consent
category first.

## Legal pages

`Create default pages` in the admin (or `ensureDefaultPages`) creates and publishes Terms, Privacy, Cookies,
Refunds, GDPR, Security and Subprocessors when they do not exist yet, never overwriting an existing page. The jobs
Worker's scheduled handler also runs the same step on every cron tick (`ensureDefaultPagesAsSystem`), so a fresh
environment gets these pages without a manual step. It acts as the system actor `DEFAULT_PAGES_ACTOR` (recorded in
the audit log), is idempotent (one query when every page exists) and never touches an existing page, edited,
unpublished or not. Their text
is marked as a draft and carries `[TO BE CONFIRMED]` placeholders (`packages/marketplace/src/pages/legal-pages.ts`);
replace them after legal review. The subprocessor list
names only services in use: Cloudflare, GitHub (only when GitHub sign-in is configured), and the npm registry as a
data source.
