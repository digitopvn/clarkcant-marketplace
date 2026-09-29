# Fixes for re-review minors m1–m6

- Date: 2026-09-29 (Asia/Saigon). Branch dev, base 6c0aae9. Nothing was committed, pushed or deployed.
- Verification: a tester subagent ran the gates, because this session's shell ran no commands. gates.sh passed: verify (lint, typecheck, tests), build and migrations:check. The test run was 41 files passed and 1 skipped; 323 tests passed and 3 skipped.
- Caveat: the tester confirmed the seven new tests by file and line and saw a green run that included their files. It did not send a verbose pass line for each named test.

## Changes
- **m1 discovery** (`indexing/discovery.ts`, `indexing-errors.ts`, `index-package.ts`)
  - The rejection error text now has one definition (`rejectionErrorText`), and `isRejectionErrorText` recognises every `IndexingRejectionCode` prefix.
  - Discovery skips a `failed` version for good only when it was a deterministic rejection.
  - A transient failure becomes eligible again after 24 hours (`TRANSIENT_RETRY_INTERVAL_MS`, measured from `updatedAt`). Discovery stops after 5 transient failures (`MAX_TRANSIENT_FAILURES`); a person can still resubmit.
- **m2 default pages** (`pages/default-pages.ts`)
  - The cron treats a page as an unfinished seed only if its `page.created` audit event was written by `system/jobs.default-pages`.
  - The page must also still be unpublished revision 1 with a null author. A null author alone no longer counts.
- **m3 finalize** (`index-package.ts`, `audit/audit-writer.ts`)
  - The `package.indexed` audit insert, the `packages` update and the submission status now run in one batch.
  - The audit insert is an insert-select whose `actor_type` becomes NULL unless `latest_version IS <value read>` still holds, so the NOT NULL constraint aborts the whole batch. This is the same trick `movePublishedPointer` uses.
  - That constraint error is rethrown as the retryable "changed during finalize" error. `prepareAuditEvent` now also returns `row`.
- **m4 rate limit** (`apps/web/src/middleware/rate-limit.ts`)
  - A new `clientNetworkKey` keys IPv6 callers by their /64.
  - It handles `::` compression, zone ids and embedded IPv4. IPv4-mapped addresses reduce to the IPv4 address, and anything unparsable is passed through unchanged.
- **m5 search re-sync** (`search/search-index.ts`, `account-deletion.ts`, `package-claims.ts`)
  - A new `syncPackageSearchDocumentsAfterCommit` catches sync errors and logs them with `console.error`, so a committed deletion or claim is still reported as a success.
- **m6 guards** (new `accounts/session-guards.ts`, plus `api-tokens.ts`, `publisher-service.ts`, `account-deletion.ts` and `packages/api/src/routes/me.ts`)
  - `requireSignedInSession` (only `type === "user"` passes) now runs inside `createApiToken`, `revokeApiToken` and `deleteAccount`.
  - `requireVerifiedEmail` now runs inside `acceptInvitation`, before the invitation lookup.
  - The route-level copies were removed, and the HTTP responses (403 with `session_required` or `email_unverified`) are unchanged.
  - The comments in `contracts/src/scopes.ts` and `device-links.ts` were corrected: only OAuth clients use `devices:link`, and device-flow sessions are `user` actors that hold `account:write`.

## Tests added or updated
- `indexing-hardening.test.ts`
  - Transient retry: a failure older than a day is resubmitted, a recent one or a rejection is skipped, and 5 failures stop it.
  - Finalize: when the pointer moves right before the batch, nothing is written (no `package.indexed` event, no pointer write, and the submission ends `failed`).
- `pages/default-pages.test.ts`: an editor's draft at `privacy`, identical to the default, whose author was deleted, is not published.
- `accounts.test.ts`
  - Deletion succeeds and the error is logged when the search re-sync fails.
  - Token actors (a full-scope `cmk` token and OAuth) cannot create or revoke tokens.
- `publishers.test.ts`: an unverified account gets `forbidden` / `email_unverified`, then accepts once verified. Existing invitees were marked verified.
- `apps/web/test/request-policies.test.ts`: IPv6 /64 keying cases.

## Notes
- There is no route-level pre-check before the idempotency reservation. A refused token call releases its key through `withIdempotency`'s failure path, so there is no behaviour change.
- Documentation: none needed. The API contract and OpenAPI summaries are unchanged.

Status: DONE_WITH_CONCERNS
Summary: All six minors are fixed with tests, and gates.sh passed (run by a tester subagent).
Concerns: This session's shell could not execute commands, so every result above comes from the tester's report. It did not return verbose per-test output.
