# Cross-cutting follow-ups: implementation report

Status: completed. `gates.sh` is green: verify (lint, typecheck, tests) passed with 323 tests passing and 3 skipped,
and the build and migrations:check steps passed. Nothing was committed, pushed or deployed.

## 1. Device linking for OAuth clients (`devices:link`)

- `packages/contracts/src/scopes.ts` adds the new scope `devices:link`, which follows the `resource:verb` naming.
  `USER_SCOPES` (`actor.ts`) includes it, so sessions and device-flow session tokens hold it.
- `OAUTH_API_SCOPES` is derived from `API_SCOPES`, so OAuth clients are offered the new scope automatically. It
  appears in discovery and MCP `scopes_supported`, and clients can register for it. `account:write` and `admin`
  stay withheld. The comment in `create-auth.ts` has been updated.
- `packages/marketplace/src/accounts/device-links.ts`: link and unlink accept `devices:link` or `account:write`.
  Listing accepts `devices:link` or `account:read`. Existing sessions and `cmk_` tokens keep working, and
  `devices:link` grants nothing else.
- `packages/api/src/routes/me.ts`: the device route summaries now name the scopes. The handlers are unchanged
  because the service enforces the scopes.
- `apps/web/src/pages/oauth/consent.astro`: consent text added for `devices:link`.
- `packages/sdk/src/generated/openapi.ts` was regenerated (`pnpm --filter @marketplace/sdk openapi:generate`). The
  diff is larger than the scope enum because the SDK was stale: it now also includes the Idempotency-Key headers
  and the 409/422 responses from the earlier fixes, plus the session-only summaries for token create and revoke.
- The CLI and MCP have no device-link code. The CLI uses the device flow, and its session holds the scope.
- Tests:
  - `packages/api/test/me-account-safety.test.ts` runs a real OAuth flow (register, PKCE authorize, consent, token)
    with the scopes `openid devices:link`. The token can link, list and unlink a device. It gets 403 for
    `POST /me/tokens`, `DELETE /me`, `DELETE /me/oauth/grants/{id}`, `POST /me/publishers` and `GET /me`.
  - `packages/marketplace/test/accounts.test.ts` covers the same limits at the service level, and checks that one
    account cannot unlink another account's device.
  - `packages/auth/test/auth-flows.test.ts`: discovery lists `devices:link`, and the device-flow session holds it.
- Docs updated: `docs/clarkcant-account-linking.md` (credential table, OAuth scope example, which credentials can
  link, list and unlink, and what `devices:link` cannot do) and `docs/security-boundaries.md`.

## 2. README check label

`packages/seo/src/package-labels.ts` now gives the `readme` check the label "README". Its summary explains that the
README was too large to show and was left out.

## 3. Default pages seeded by the jobs Worker

`docs/security-boundaries.md` (Legal pages) now says that the jobs Worker's scheduled handler runs
`ensureDefaultPagesAsSystem` on every cron tick. It runs as the system actor `DEFAULT_PAGES_ACTOR` (audited), is
idempotent and never overwrites an existing page.

## 4. Sitemap paging

`apps/web/src/server/site-index.ts`: the pages sitemap now reads pages in batches of `MAX_PUBLISHED_PAGES_LISTED`
using `afterSlug`. It keeps only the URL for each page, not the document, and caps the list at the 50,000-URL
protocol limit. The published home is still detected across all batches. `MAX_PUBLISHED_PAGES_LISTED` is now
exported from `@marketplace/marketplace`. The new test in `apps/web/test/site-index.test.ts` seeds 2,005 published
pages with three SQL statements and checks that every page is listed exactly once. That test would fail against the
old single-read code.

## 5. Consent page label

The consent page now shows an "Unverified client" badge on every client. It explains that the name (and website,
if one is present) was supplied by the client itself, and it shows the client id. No data model change was needed:
every client registers itself (RFC 7591) and nothing verifies any of them.

## 6. Jobs CPU limit

`apps/jobs/wrangler.jsonc` sets `"limits": { "cpu_ms": 30000 }` at the top level and repeats it in the staging and
production environments. Note that 30 s is also the Workers Paid default, so this pins the budget rather than
raising it. `docs/operations.md` explains the setting and says to raise it if the logs show `exceededCpu`.

## 7. Known limitation

A new "Known limitations" section in `docs/operations.md` records that search sync still scans the whole
`packages_fts` table, and that fixing it needs a mapping table and a migration.

Status: DONE
Summary: The `devices:link` scope restores ClarkCant desktop device linking over OAuth without returning
`account:write`. Tasks 2 to 7 are done, and the new tests and all gates pass.
Concerns:
- OAuth grants issued before this change hold no `devices:link`. Desktop clients must re-authorize and request it.
- The regenerated SDK also picks up API changes from the earlier fix passes, as described in section 1.
- `cpu_ms` 30000 matches the Paid default. Raise it if README rendering ever hits the limit.
