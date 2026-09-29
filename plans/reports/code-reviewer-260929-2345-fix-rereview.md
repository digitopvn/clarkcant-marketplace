# Re-review of fix commit 9d09e86

- Date: 2026-09-29 (Asia/Saigon). This was a review only; no source was edited.
- Scope: the whole commit (80 files) against the three 2230 review reports and the four fix reports.
- Tests: `pnpm vitest run` over the pages, indexing-hardening, account-deletion-media and accounts tests in `packages/marketplace`, plus `me-account-safety` in `packages/api`, `apps/web/test`, `apps/cli/test`, `packages/mcp` and `packages/auth`. Result: 14 files and 104 tests, all passing.
- Not run: lint, typecheck, Playwright. The shell stopped returning output partway through the review, so the `safeNextPath` edge cases were checked by reasoning about the WHATWG URL rules, not by running them.

## Status of the original major findings
- Security M1 (open redirect): fixed. Control characters and `\` are rejected, the value is resolved against a placeholder origin and must stay on it, and a result starting with `//` is rejected. That last check covers `/.//x` and `/%2e//x`, which resolve to `//x`.
- Security M2 (rate-limit bypass): fixed, with a remaining IPv6 gap (m4).
- Security M3 (tokens minted by OAuth or token callers): fixed. `account:write` is withheld from OAuth, and token create/revoke refuse `type === "token"` callers.
- Security M4 (admin runbook): fixed. Verification is now by user id plus email.
- Domain M1–M8: all fixed. M1's fix goes further than intended (m1). M8's write is not atomic with the rest of `finalize` (m3).
- Delivery 1, 3 and 4: fixed.
- Delivery 2 (preview workflow secrets): only partly fixed. See the major finding below.
- `devices:link` behaves as intended. `hasScope` is an exact match (only `admin` implies other scopes). OAuth scopes are `OAUTH_API_SCOPES ∩ grant` (`request-auth.ts:188`). The only checks that accept it are in `device-links.ts`, and link/list/unlink filter by `userId`. The tests show it gets 403 on `/me/tokens`, `DELETE /me`, grant revocation and `GET /me`.

## Major

### M1. The preview workflow still exposes the account-wide Cloudflare token to code in any same-repo PR
- Where: `.github/workflows/preview.yml:28,83,97` and `docs/deployment.md:40-45,60-61`.
- Evidence:
  - The docs table still describes `CLOUDFLARE_API_TOKEN` as a repository secret with "Workers, D1, R2, Queues edit rights for the account". The preview job receives it through `environment: staging`.
  - Keeping the token out of the install and build steps does not protect it:
    - `pnpm install` (line 83) runs the PR's lifecycle scripts. Those scripts can replace `node_modules/.bin/wrangler`, and the upload step then runs that binary with the token (line 97).
    - On `pull_request`, a same-repo PR runs its own copy of `preview.yml`, so the PR author can simply edit the workflow.
  - The docs describe this as "the same trust as pushing to `dev`". That holds only if `dev` is unprotected. If `dev` requires reviewed PRs, previews extend the prod-capable token to anyone who can push a branch, without any review.
  - `docs/deployment.md:44-45` suggests setting a narrower token on `production` later. That is the wrong way round: the job that exposes the token runs in `staging`/preview.
- Fix:
  - Create a dedicated `preview` environment with required reviewers.
  - Give it a token limited to Workers Scripts edit, with no D1, R2 or Queues rights. `versions upload` needs only that.
  - Move the account-wide token from the repository to the `staging` and `production` environment secrets.
  - Correct the doc lines above. The step-level scoping can stay, but it should not be described as isolation.

## Minor

### m1. Discovery never retries a transient failure
- Where: `packages/marketplace/src/indexing/discovery.ts:111`.
- Evidence: every `failed` submission is skipped for good, including `index_failed` after the retry limit was reached (an npm, R2 or CPU hiccup). The original fix recommended skipping only deterministic rejections. As it stands, a short outage during indexing means that version is never discovered automatically.
- Fix: skip `failed` only when the error is an `IndexingRejectedError` code. Otherwise retry after a backoff, for example when `updatedAt` is more than 24 hours old, up to N attempts.

### m2. The cron can publish an editor's unpublished draft after that editor deletes their account
- Where: `packages/marketplace/src/pages/default-pages.ts:214`.
- Evidence: the check for a page the cron seeded but never finished is "revision 1, `authorId === null`, unpublished". But `page_revisions.author_id` is `ON DELETE SET NULL` (`packages/db/src/schema/pages.ts:54`). Suppose an editor keeps an unpublished revision-1 draft at a default slug (for example `privacy`) and then deletes their account. On the next 10-minute tick the cron publishes it as `jobs.default-pages`, even though the docs say existing pages are never touched.
- Fix: recognise system-seeded pages by their `page.created` audit actor (`system/jobs.default-pages`), or by comparing the document with `DEFAULT_PAGES[].document`.

### m3. The `latestVersion` check-and-set commits separately from the rest of `finalize`
- Where: `packages/marketplace/src/indexing/index-package.ts:421-432`.
- Evidence: the conditional `UPDATE packages` commits before the batch that writes the submission status and the audit event. If that batch keeps failing until retries run out, the listing pointer has moved with no audit row, and the submission ends up `failed`. With m1, discovery then never revisits it.
- Fix: put the condition inside the batch using the insert-select NOT NULL trick that `movePublishedPointer` already uses, so the whole batch aborts when the condition fails.

### m4. The IP rate-limit key uses the full IPv6 address
- Where: `apps/web/src/middleware/rate-limit.ts:44-45`.
- Evidence: a client with a /64 prefix can switch to a new address, and so a new budget, on every request. For IPv6 clients, M2 is only partly closed.
- Fix: when the address contains `:`, key on its first four hextets (the /64).

### m5. Search re-sync runs after the commit and can fail the request
- Where: `packages/marketplace/src/accounts/account-deletion.ts:158` and `publishers/package-claims.ts:82`.
- Evidence: if `syncPackageSearchDocument` throws, the account is already deleted or the claim already approved, but the caller gets a 500. A retry then fails with 401 or 409.
- Fix: catch and log the sync error (the index can be rebuilt from the tables), or add the FTS statements to the same batch.

### m6. The session-only guards are enforced only in the HTTP route, and two comments are inaccurate
- Where: `packages/api/src/routes/me.ts:290` and `requireVerifiedEmail`.
- Evidence (guards): `createApiToken`, `revokeApiToken` and `acceptInvitation` in `packages/marketplace` do not check for a session or a verified email themselves. Any future MCP or internal caller would bypass these guards.
- Evidence (comments): `contracts/src/scopes.ts:20-21` and `device-links.ts:22` say device-login clients "are never offered" `account:write`. In fact device-flow sessions, including `clarkcant-desktop`, are `type: "user"` actors that hold `account:write` and can mint tokens (`auth-flows.test.ts:200`).
- Fix: move both guards into the services. Correct the comments to say that only OAuth clients use `devices:link`.

## Checked and found sound
- 409 on concurrent draft saves: the new number is `base.number + 1`, the draft pointer only ever moves forward, and a `(page_id, number)` unique violation becomes `conflict`.
- `IN (...)` lists are chunked at 90 or fewer, and the sitemap uses keyset pagination.
- Archive limits: the kept-bytes budget, the stateful selector, and the linear `StreamReader`. README limits: 256 KB of source and 512 KB of HTML, with a `warn` check recorded when a README is omitted.
- Media used by pages survives account deletion: the delete and the `NOT EXISTS` check are one statement, and a prefixed id does not count as a reference (tested).
- Default pages: the audit records the system actor, the cron never overwrites an existing page, and a conflict counts as "existing".
- `release-tag` job: `needs: deploy`, `main` only, and it is the only job with `contents: write`. `--config wrangler.jsonc` resolves correctly, because `pnpm --filter … exec` runs in `apps/web` and `migrations_dir` is relative to that file.
- CLI: only https is accepted, except plain http on a loopback host, and the check applies to both the flag and the environment variable. MCP answers 413 for oversized bodies. Preview tokens are removed from log paths.

## Unresolved questions
1. Does the `staging` environment restrict deployment branches or require reviewers? The answer decides whether M1 is a real exposure or whether previews simply fail.
2. Should cron seeding auto-publish the legal draft pages on production without anyone reviewing them?

Status: DONE_WITH_CONCERNS
Summary: All 16 original major findings are addressed except delivery finding 2: the preview job still gives an account-wide, prod-capable token to PR code, so it remains major. There are 6 minor regressions or gaps: permanent discovery skips, a default-page heuristic that can publish an editor's draft after account deletion, a non-atomic `finalize` check-and-set, the IPv6 rate-limit key, post-commit search sync errors, and session guards and comments that live only at the route layer. The focused tests pass.
