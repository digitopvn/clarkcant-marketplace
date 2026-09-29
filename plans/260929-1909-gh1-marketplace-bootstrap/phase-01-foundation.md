# Phase 01 — Foundation (M0 + shared domain skeleton)

Status: pending · Wave 1 · Blocks all other phases.

## Goal
A pnpm monorepo where `pnpm install && pnpm verify && pnpm build` pass, `pnpm dev` boots the
Astro app in the Workers runtime with D1/R2/Queue bindings, `/api/v1/health`, `/api/v1/packages`
and `/openapi.json` respond through the shared application layer, and CI workflows exist.

## Read first
- `plans/reports/researcher-260929-1909-cloudflare-stack-integration.md` (pins and snippets — authoritative)
- `plans/reports/scout-260929-1914-clarkcant-ecosystem-facts.md` (manifest schema, brand, conventions)
- `plans/260929-1909-gh1-marketplace-bootstrap/plan.md` (contract, resource ids)
- GitHub issue #1 (`gh issue view 1 --repo digitopvn/clarkcant-marketplace`)

## Pinned versions (exact, `save-exact`)
astro 7.3.5, @astrojs/cloudflare 14.3.3, @astrojs/react 7.0.0, react/react-dom 19.3.0,
tailwindcss + @tailwindcss/vite 4.3.3, hono 4.13.11, @hono/zod-openapi 1.6.3, zod 4.6.5,
drizzle-orm 0.45.3, drizzle-kit 0.31.11, better-auth 1.7.6, wrangler 4.143.0, vitest 4.1.11,
typescript 6.0.3, @playwright/test 1.63.0. Node ≥22, pnpm 10.32.1 via `packageManager`.

## Layout to create
```
apps/web            Astro 7 SSR on Workers (+ React islands, Tailwind v4, design tokens)
apps/jobs           plain Worker: queue consumer + Workflow class (entry only in this phase)
apps/cli            (created in phase 05)
packages/contracts  Zod schemas + inferred types: errors, pagination, scopes, package DTOs,
                    clarkcant manifest (mirror of ClarkCant packageManifestSchema), PageDocument/BlockNode,
                    submission, audit event, idempotency; JSON Schema export via z.toJSONSchema
packages/db         Drizzle schema split by domain file + `createDb(d1)`; drizzle.config.ts → /migrations
packages/marketplace application services (commands/queries). Takes a `MarketplaceDeps`
                    { db, queue?, media?, now(), ids() }. Domain folders: packages/, search/,
                    pages/, collections/, publishers/, audit/, idempotency/. This phase: package
                    read queries + search (FTS5) + categories/collections reads + audit writer +
                    idempotency store, with unit tests.
packages/api        Hono OpenAPIHono app factory `createApi(deps factory)`; `/api/v1/*` routes split per
                    file in src/routes/{health,packages,search,catalog,pages,me,publish,admin}.ts;
                    structured error handler (contracts error shape), request-id, `/openapi.json`.
                    Only health/packages/search/catalog get real handlers now; other files export
                    a router with their real endpoints added by later phases (register all in app.ts now).
migrations/         drizzle-generated SQL for the FULL schema below
```
Workspace packages resolve to `src/index.ts` (no build step), name scope `@marketplace/*`.

## Full D1 schema (define all now so wave 2 needs no migration renumbering)
- Auth (Better Auth core + plugins organization, passkey, deviceAuthorization, jwt, oauth-provider,
  generated with the `auth` CLI or hand-written to match 1.7.6): user, session, account,
  verification, passkey, organization, member, invitation, deviceCode, jwks, oauth client/
  access token/consent tables. Add `user.role` ('user'|'admin').
- `publishers` (id, slug, name, kind org|person, organization_id → better-auth organization,
  verified_at, created_at), `publisher_domains`, `publisher_repositories`
- `clarkcant_device_links` (id, user_id, local_principal_id `prin_*`, device_label, created_at, revoked_at)
- `api_tokens` (id, user_id, name, token_hash, scopes json, last_used_at, expires_at, revoked_at)
- `packages` (id, name unique npm name, publisher_id, display_name, description, latest_version,
  homepage, repository_url, license, keywords json, category_slug, curation_status
  unreviewed|listed|featured|hidden|rejected, verified_publisher bool, indexed_at, created_at, updated_at)
- `package_versions` IMMUTABLE (id, package_id, version, manifest json, readme_md, readme_html (sanitized),
  npm_integrity, tarball_sha512_verified bool, provenance json|null, published_at, indexed_at;
  unique(package_id, version))
- `package_facets` (package_version_id, kind, isolation, renderer, entry, widget_id)
- `package_permissions` (package_version_id, kind capability|network|filesystem|microphone|camera|lifecycle, value, access)
- `package_previews` (package_version_id, kind image|video|social_card, media_id, alt)
- `package_claims`, `package_audits` (security facts separate from curation), `package_submissions`
  (id, package_name, version|null, submitted_by, status queued|indexing|indexed|failed, error, workflow_id)
- `categories` (slug, name, description, position); `collections` + `collection_items` (position)
- FTS5 virtual table `packages_fts`(name, display_name, description, keywords, publisher, facets)
  maintained by application code (write-through in the indexing command), not triggers.
- `media` (id, sha256, r2_key `sha256/ab/cd/<digest>.<ext>`, content_type, bytes, width, height, owner_user_id, created_at)
- `layouts` (id, version, name, definition json), `pages` (id, slug unique, kind custom|legal|docs|landing|category|collection,
  title, current_draft_revision_id, published_revision_id, created_at, updated_at),
  `page_revisions` IMMUTABLE (id, page_id, number, document json, author_id, created_at, parent_revision_id),
  `page_publications` (id, page_id, revision_id, published_by, published_at, action publish|rollback)
- `audit_events` (id, actor_type user|token|system, actor_id, action, subject_type, subject_id, idempotency_key, data json, created_at)
- `idempotency_keys` (key, scope, request_hash, response json, status_code, created_at)
Add sensible indexes. Seed migration: categories (widgets, dashboards, productivity, data, media, developer-tools).

## Web app shell (apps/web)
- Astro config: `@astrojs/cloudflare` (session disabled or KV declared), React, Tailwind v4 via Vite plugin.
- `src/pages/api/[...path].ts` and `src/pages/openapi.json.ts` delegate to `createApi` with
  `import { env } from "cloudflare:workers"`.
- Design tokens from ClarkCant brand (tokens.css; light/dark via prefers-color-scheme with no flash;
  Instrument Serif / Geist / Geist Mono from Google Fonts). Base layout with header/footer, skip link.
- Home page (`/`) server-renders featured/latest packages from the application layer (real query,
  empty state when none). `/packages` list + search box (GET form) using the search service.
- `wrangler.jsonc` in apps/web and apps/jobs with top-level dev config and `env.staging`/`env.production`
  repeating every binding (DB, MEDIA R2, INGEST_QUEUE producer, INDEX_WORKFLOW with script_name of the
  jobs worker per env, vars PUBLIC_SITE_URL, ENVIRONMENT, ADMIN_EMAILS). Worker names per plan.md.
  `compatibility_flags: ["nodejs_compat"]`, recent compatibility_date.
- apps/jobs: queue consumer + `IndexPackageWorkflow extends WorkflowEntrypoint` whose run() calls a
  function exported from packages/marketplace (implemented in phase 03; here it may call a placeholder
  that throws `not implemented` — must not fake success). Cron trigger declared for npm discovery.

## Env validation
`packages/contracts/src/env.ts`: Zod schema for runtime vars; fail fast with a clear error at request time.

## Tooling
- Root scripts: `dev`, `build`, `typecheck` (tsc -b or per-package `tsc --noEmit` + `astro check`),
  `lint` (ESLint flat config, typescript-eslint), `test` (vitest workspace/projects), `test:e2e`
  (Playwright against `astro dev` or `astro preview`), `db:generate`, `db:migrate:local`,
  `db:migrate:staging`, `db:migrate:production`, `migrations:check` (drizzle-kit check + verify
  generated SQL is committed: `drizzle-kit generate` produces no diff), `verify` (lint+typecheck+test).
- Vitest: domain/service tests run against a real SQLite D1 via `@cloudflare/vitest-pool-workers`
  (vitest 4.1.11) applying `/migrations`; if that proves infeasible, use Miniflare D1 directly. No mocks of the DB.
- Playwright smoke: home renders, `/api/v1/health` 200, `/openapi.json` valid JSON with paths.
- `.gitignore`, `.editorconfig`, `.nvmrc` (24), `.env.example` / `.dev.vars.example` (names only).

## CI (.github/workflows)
- `ci.yml` on pull_request + push to any branch except dev/main: install (pnpm cache), lint, typecheck,
  unit tests, build, migration validation, Playwright critical paths (local).
- `deploy.yml` on push to `dev` → environment `staging`, to `main` → environment `production`:
  same verification job, then `wrangler d1 migrations apply <db> --remote --env <env>` (print list
  before/after), deploy jobs worker, `CLOUDFLARE_ENV=<env> pnpm --filter web build && wrangler deploy`,
  smoke tests against the deployed URL (curl health + openapi + home), Playwright critical paths
  against the deployed URL (staging), and on main a GitHub deployment/release marker (tag
  `release-YYYYMMDD-HHMM` or `gh release`). Secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
- `preview.yml` for PRs: `wrangler versions upload --preview-alias pr-<n>` against staging, comment URL;
  skip cleanly with a notice when the secret is absent on forks.

## Acceptance
- `pnpm install --frozen-lockfile && pnpm verify && pnpm build` green locally.
- `pnpm db:migrate:local` then `pnpm dev`: `/`, `/packages`, `/api/v1/health`, `/api/v1/packages`,
  `/api/v1/search?q=`, `/api/v1/categories`, `/openapi.json` respond correctly.
- Unit tests cover package queries, FTS search, audit writer, idempotency store, manifest schema.
- No secrets committed. Short `README.md` (commands) and `docs/architecture.md` draft (layers + boundaries).

## Out of scope here
Page engine, indexing pipeline, auth flows, MCP/CLI/SDK, SEO surfaces (later phases own them).
