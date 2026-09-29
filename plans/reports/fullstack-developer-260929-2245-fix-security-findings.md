# Fix verified security findings (security-boundaries review + web-clients finding 1)

- Branch `dev`, 2026-09-29 (Asia/Saigon). Not committed, pushed or deployed. No dev servers were started.
- Gates (`gates.sh`): verify exit 0 (308 passed, 3 skipped), the web/jobs bundle exit 0, migrations:check exit 0.

## Fixes

| Finding | Change | Tests |
|---|---|---|
| M1 / web #1: open redirect via `next` | `safeNextPath` (`apps/web/src/components/auth/request.ts`) rejects control characters and backslashes up front, resolves with `new URL(next, placeholder origin)`, requires the same origin, returns path+search+hash, and refuses results that normalise to `//` (for example `/.//evil.com`). The login and signup pages, the `AuthForm` redirect and the GitHub `callbackURL` all go through it, so none of them needed changes. | `apps/web/test/auth-redirects-and-logs.test.ts`: `%09`, `%0a`, `%0d`, `/\`, `\/`, `%5C`, `%2F%2F`, `/%2F/`, `/.//`, `/%2e//`, NUL, `javascript:`, plus a resolve-stays-on-origin check |
| M2: rate-limit bypass | `rateLimitKey` now keys by `CF-Connecting-IP` only (it is synchronous now, with no hashing). The limiter runs before authentication, so any credential it sees is unverified. | `request-policies.test.ts`: rotating random bearer, `cmk_` and session-cookie values all land in the same IP key |
| M3: long-lived tokens via OAuth/tokens | `OAUTH_API_SCOPES` withholds `admin` and `account:write`. Existing OAuth JWTs lose `account:write` too, because resolution intersects with this list. In `packages/api/src/routes/me.ts`, `POST /me/tokens` and `DELETE /me/tokens/{id}` reject `token` actors with 403 `session_required`. This matches `deleteAccount`: a session cookie or a device-flow session bearer is allowed. | `auth-flows.test.ts`: metadata omits `account:write` and registration asking for it is refused. `packages/api/test/me-account-safety.test.ts`: a `cmk_` token with `account:write` cannot mint or revoke tokens. |
| M4: admin bootstrap squatting | `docs/operations.md` has a new procedure. The person sends their user id (from `/api/v1/me`) over a trusted channel. The operator checks the user, account and session rows (created time, providers, IP/UA). A squatted row gets its email freed and its sessions ended. Verification is `WHERE id = … AND email = …`. The doc also warns about pre-registration squatting and names the `account_not_linked` symptom. | docs only |
| m1: preview token in logs | `logPath()` in `request-log.ts` turns `/preview/<token>` into `/preview/:token`. It is used by the request, request_failed and rate_limited log lines. | `auth-redirects-and-logs.test.ts` |
| m2: MCP body cap | `handleMcpRequest` reads a POST body once through a bounded reader before auth. It answers 413 `payload_too_large` for a declared or streamed body over 8 MiB, and gives the protocol handler the buffered copy, so there is no second `clone().json()`. `upload_media.base64` now has `.max(ceil(5 MiB/3)*4)`. | `mcp-endpoint.test.ts`: declared oversize, chunked oversize without length, normal call still 200, oversized base64 rejected |
| m3: invitation email | `POST /me/invitations/{id}/accept` requires `emailVerified` (403 `email_unverified`). The check is enforced in the API route, because the marketplace service is outside my files. | `me-account-safety.test.ts`: unverified gets 403, verified gets 200 |
| m4: consent screen | `ConsentForm.tsx` (my file) shows the redirect host from the server-signed `redirect_uri`, marks loopback as "an app on this device", and warns that app names are self-chosen. Helper: `describeRedirectTarget` in `request.ts`. | `auth-redirects-and-logs.test.ts` |
| m5: Idempotency-Key on /me writes | Every `/me/*` POST (tokens, device link, publishers, invitations, accept, domains + verify, repositories + verify, claims) accepts the header through `withIdempotency`, scoped `user:<id>:me.<op>`. OpenAPI documents the header and 409/422. For token creation the plaintext is never stored for replay: a retry answers 409 naming the token id. | `me-account-safety.test.ts`: replay returns the same publisher, a different body gives 422, a token retry gives 409 without the plaintext and only one token exists |
| m6: docs | `security-boundaries.md`: curation is REST-only except feature/unfeature and collections via MCP, CSP is sent as a header (checked on staging), rate limits are keyed by IP, and the new account/OAuth/invitation/`next`/preview-log rules are documented. `mcp.md`: AVIF removed, 8 MiB/413 documented, OAuth never gets `account:write`, `feature_package` note added. `operations.md`: curation line. The `astro.config.ts` comment now says the CSP is a header, not a `<meta>` tag. | |

## Files modified
- `apps/web/src/components/auth/request.ts`, `ConsentForm.tsx`; `apps/web/src/middleware/rate-limit.ts`, `request-log.ts`; `apps/web/astro.config.ts` (comment only)
- `packages/auth/src/create-auth.ts`; `packages/api/src/routes/me.ts`; `packages/mcp/src/mcp-endpoint.ts`, `marketplace-tools.ts`
- Tests: `apps/web/test/request-policies.test.ts`, new `apps/web/test/auth-redirects-and-logs.test.ts`, `packages/auth/test/auth-flows.test.ts`, new `packages/api/test/me-account-safety.test.ts`, `packages/mcp/test/mcp-endpoint.test.ts`
- Docs: `docs/operations.md`, `docs/security-boundaries.md`, `docs/mcp.md`
- Generated, outside my list: `packages/sdk/src/generated/openapi.ts`, regenerated with `pnpm --filter @marketplace/sdk openapi:generate`. The SDK digest test fails otherwise, because the `/me` OpenAPI changed. The diff contains only my header, 409/422 and summary changes.

## Design notes
- M2: I chose IP-only keying over a post-auth credential bucket. `apps/web/src/server/api.ts`, which wires the API, is not in my files. Resolving auth inside the limiter would also add a lookup before throttling. Trade-off: callers behind one IP (NAT, CI egress) share a budget, for example 10 publish requests per minute per IP. This is documented.
- The session requirement for tokens accepts device-flow session bearers, as `deleteAccount` does. If "browser session" should mean cookie only, the check would need the credential kind from the actor middleware.

## Concerns / follow-ups (outside my files)
1. `docs/clarkcant-account-linking.md:34,54` still says OAuth clients get `account:write` and can link devices. OAuth clients now cannot call `POST /me/devices/link`. Desktop linking must use the device flow (session bearer) or a `cmk_` token. The doc needs updating.
2. `apps/web/src/pages/oauth/consent.astro`: add the "unverified (self-registered) client" label. This needs DCR-vs-first-party data from `describeOAuthClient` in `packages/marketplace`. Its `SCOPE_TEXT` entry for `account:write` is now unused but harmless.
3. m3 consequence: email/password accounts are never verified (no mailer, and GitHub cannot link onto an unverified local account), so today only GitHub sign-ups can accept invitations. Otherwise an operator has to verify the account by id per the runbook. Consider moving the check into `acceptInvitation` in `packages/marketplace` for defence in depth.
4. `createApiToken`/`revokeApiToken` in `packages/marketplace` still allow token actors. The guard lives in the REST route, which is the only caller today because MCP has no token tool. Moving it into the service would protect future callers.

Status: DONE_WITH_CONCERNS
Summary: All requested fixes are implemented with focused tests, and verify, the bundle step and migrations:check are green. Remaining items are outside my file ownership: the account-linking doc, the consent page's unverified label, and optionally moving the guards into the marketplace services.
Concerns/Blockers: Removing OAuth `account:write` means OAuth desktop clients can no longer link devices; `docs/clarkcant-account-linking.md` needs an update by its owner.
