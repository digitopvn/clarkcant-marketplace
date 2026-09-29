# Fix delivery findings 2-9 (web clients / delivery review)

- Source review: `plans/reports/code-reviewer-260929-2230-web-clients-delivery.md`. Finding 1 was left to its owner.
- Date: 2026-09-29 (Asia/Saigon). Nothing was committed, pushed or deployed, and no dev server was started.

## Changes by finding

2. **Preview workflow** (`.github/workflows/preview.yml`), rewritten:
   - Top-level `permissions: {}`. The `upload` job has `contents: read` and `environment: staging`; the `comment` job has only `pull-requests: write` and runs no PR code.
   - It runs only when `head.repo.full_name == github.repository`, so fork PRs are skipped.
   - The token (repo-level secret, still visible through the environment) is given only to the `wrangler versions upload` step. Install and build run without it. Checkout uses `persist-credentials: false`.
   - It never migrates. When a PR touches `migrations/` (`git diff HEAD^1 HEAD` on the merge commit, `fetch-depth: 2`), the upload is skipped and the PR comment says why.
   - The limitation is documented in `docs/deployment.md#pr-previews`: previews use staging D1/R2/queue and their writes are real.
3. **Docs**: `CLOUDFLARE_API_TOKEN` is now documented as a repository secret and `CLOUDFLARE_ACCOUNT_ID` as a repository variable, in both `docs/deployment.md` and `README.md`. The configuration check in `deploy.yml` now names the kind of each missing item.
4. **E2E**:
   - The staging Playwright step sets `E2E_BUILT=1`, so the CSP and JS-budget tests run there.
   - It also passes `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` from `secrets.*`. When they are absent, the builder flow is skipped.
   - How to enable the builder flow is documented: add the address to ADMIN_EMAILS, sign up on staging and verify the email, then set the GitHub secrets.
   - `e2e/seo-a11y.spec.ts` now also tests "Copy as Markdown": it checks the fetch is same-origin and that the status and clipboard are right.
5. **Sitemap** (`apps/web/src/server/site-index.ts`): the built-in `/` is added only when no published page owns `/`. A noindex published home is therefore omitted; other noindex pages were already filtered out. The new test `apps/web/test/site-index.test.ts` covers three cases: no home page, an indexable home page (listed once), and a noindex home page (omitted).
6. **Share bar** (`ShareBar.astro`): the page now fetches `pathname + search` of the Markdown URL, which is same-origin. The absolute URL is still used in the copied text.
7. **CLI** (`apps/cli/src/cli.ts`):
   - `checkedOrigin()` accepts `https:`, and `http:` only for `localhost`, `*.localhost`, `127.0.0.1` and `[::1]`. Anything else exits with code 2 and the message "refusing --api-url …: use https …".
   - This covers `CLARK_MARKET_API_URL` too, and nothing is fetched before the check.
   - New test in `apps/cli/test/cli.test.ts`: refused and allowed origins, with `CLARK_MARKET_TOKEN` set.
8. **deploy.yml**: the `deploy` job now has `contents: read`. A new `release-tag` job (`needs: deploy`, `if: github.ref_name == 'main'`, `contents: write`) does the tagging.
9. **docs/cli.md**: I took the smaller change and made the docs match the code. `--json` prints one JSON document per line, and `login` prints a `pending` line followed by the result line. Behaviour is unchanged, and the existing test relies on the pending line. The `--api-url` https rule and exit code 2 are documented as well.

- **pnpm/action-setup**: bumped from `@v4` to `@v6` in all workflows. The latest release is v6.1.0 and its `runs.using` is `node24`. v5 only moved to Node 24 and v6 added pnpm 11 support; it still reads `packageManager`.
- **Wrangler redirect question**: checked in the workers-sdk source (`workers-utils/src/config/config-helpers.ts`, `validation.ts`).
  - Without `--config`, wrangler follows `.wrangler/deploy/config.json`.
  - With `--env`, it throws when the build recorded a different `targetEnvironment`. If the build recorded none, it silently uses the flattened config, which is the wrong database.
  - `--config` disables the redirect.
  - Fix: the `db:migrate:local|staging|production` scripts and the three D1 steps in `deploy.yml` now pass `--config wrangler.jsonc`.
  - Documented in the `apps/web/wrangler.jsonc` header and in `docs/deployment.md` ("Migrations and the build redirect").

## Verification

- `pnpm vitest run --project cli --project web`: 3 files, 19 tests, all passing.
- Web `astro check` reported 0 errors. CLI `tsc` and root `tsc` passed. ESLint on the touched paths was clean.
- Workflows: all three parse with `yaml`. `actionlint` v1.7.12 (`go run`) reported nothing, but shellcheck was not installed so shell bodies were not linted. The job permissions, environments and conditions shown above were confirmed from the parsed output.
- `gates.sh`: `build` exited 0 and `migrations:check` exited 0. `verify` exited 2 because typecheck failed in a file owned by another agent: `packages/marketplace/src/collections/collection-commands.ts(105,13): Cannot find name 'isConstraintViolation'`.
- Full `pnpm test`: 292 passed and 5 failed. None of the failures are in my files:
  - `packages/marketplace` `default-pages.test.ts` (3 tests)
  - `packages/marketplace` `indexing-pipeline.test.ts` (1)
  - `packages/sdk` `sdk.test.ts` "generated from the live OpenAPI document" (1), probably API changes in progress; needs `openapi:generate`.
- Playwright was not run, because it starts the dev server. The new share-bar assertions have not been executed yet.

## Risks / follow-ups

- If the `staging` environment restricts deployment branches, PR previews will wait or fail until PR branches are allowed. The environment's protection rules now apply to previews.
- `E2E_BUILT=1` on staging also turns on the JS-budget test (`JS_BUDGET_BYTES`). The first staging run could expose a real overage or a CSP violation. That is the gate doing its job, but it could block `dev` deploys.
- Preview PR authors (who have write access) still control the code that the upload step executes. This is the same trust as pushing to `dev`, and it is documented.
- `AGENTS.md` mentions `E2E_BUILT` and `db:migrate:local`. It is outside my ownership, is still accurate, and was not edited.

Status: DONE_WITH_CONCERNS
Summary: Findings 2-9 are fixed, along with the action-setup v6 bump and the `--config` hardening for migrations. Focused tests, typecheck, lint, actionlint, build and migrations:check all pass.
Concerns/Blockers: `gates.sh verify` fails on another agent's in-progress `packages/marketplace` typecheck error. Five tests fail in marketplace/sdk, outside my ownership. Playwright was not run.
