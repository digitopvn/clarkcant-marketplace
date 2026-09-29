# Bootstrap ClarkCant Marketplace platform (GitHub issue #1)

Status: in progress · Mode: `--auto` · Source: https://github.com/digitopvn/clarkcant-marketplace/issues/1

## Brainstorm contract

### Outcome
`digitopvn/clarkcant-marketplace` becomes a programmable marketplace/content platform on
Cloudflare Workers: one canonical package + page model served through Web, REST/OpenAPI,
CLI, MCP and WebMCP, with a page builder (versioned `PageDocument` AST), npm indexing,
auth/publisher foundation, SEO/GEO machine-readable surfaces, and CI/CD that deploys
`dev` to staging and `main` to production.

### Constraints
- Stack from the issue: Astro (SSR on Workers) + React islands, Tailwind v4, Hono + OpenAPI,
  Zod, D1 + Drizzle, Better Auth, R2, Queues, Workflows, official MCP TS SDK, Vitest +
  Playwright, pnpm workspaces, GitHub Actions.
- Modular monolith: every interface delegates to `packages/marketplace` application services.
  No interface (MCP, CLI, web, jobs) owns business rules or its own D1 write path.
- Marketplace discovers/curates; npm distributes; ClarkCant executes. Listing data never
  grants runtime permissions; community code is never executed in Marketplace.
- Staging and production resources are fully separate. Expand/migrate/contract migrations.
- Secrets never committed or printed.

### Non-goals (this bootstrap)
- Vectorize semantic search (phase 2; seam only).
- Paid transactions (Refund policy states there are none).
- Executing or sandbox-previewing widget code.
- Custom domain / DNS moves (no marketplace domain is named in the brief; see assumptions).
- Converging `clark-market` with ClarkCant's own CLI.

### Acceptance criteria (= issue Definition of Done)
1. Astro runs on Cloudflare Workers locally and in staging.
2. D1 migrations and R2 bindings are defined.
3. Public API/OpenAPI works through the shared application layer.
4. A versioned PageDocument renders both HTML and Markdown.
5. Admin can create a draft custom page from predefined blocks, preview it and publish it.
6. One package can be indexed from npm metadata/manifest and shown through web + API.
7. Auth foundation supports account/publisher identity without replacing ClarkCant local identity.
8. A minimal MCP server exposes at least read/search operations through the same domain services.
9. Critical public routes emit canonical SEO metadata and Markdown alternates.
10. `dev` auto-deploys staging and `main` auto-deploys production after verification.
11. Security boundaries documented: Marketplace discovers/curates, npm distributes, ClarkCant executes.
12. Documentation lets another agent extend blocks, APIs and indexers without reverse-engineering.

Plus the milestone checklists M0–M6 in the issue, delivered as working code where feasible.

### Assumptions (decided in `--auto`)
- A1 Cloudflare account: `Digitop.vn@gmail.com's Account` (009dc0fcd0da3e503fbf38eb2b586e4b).
- A2 Resource names are prefixed `clarkcant-marketplace-*` to avoid collisions with other
  projects in the shared account (issue names were conceptual).
- A3 No marketplace domain is named; deploy to `*.workers.dev` with `PUBLIC_SITE_URL` and
  `MEDIA_BASE_URL` configurable. Media served through the web Worker route `/media/*` until a
  `cdn.<domain>` custom domain is chosen (r2.dev is never used).
- A4 Blocks and layouts live inside `packages/page-engine`; search lives in
  `packages/marketplace` (D1 FTS5). Avoids empty packages, per the issue's own guidance.
- A5 Admin identities come from `ADMIN_EMAILS` config, never source.
- A6 GitHub OAuth login is fully wired but only enabled when `GITHUB_CLIENT_ID/SECRET` exist;
  email/password + passkey work without external providers.
- A7 Agent/CLI/MCP credentials are scoped personal API tokens (hashed at rest) plus Better Auth
  device authorization for CLI login; OAuth/OIDC provider enabled as groundwork.
- A8 No ClarkCant widget is published on npm yet and npm credentials are absent; the indexer is
  verified end-to-end with a real `npm pack` tarball fixture and live registry fetches. Live
  indexing of a real widget needs one published package (authorization boundary).
- A9 Deploy from CI needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` GitHub secrets;
  first deploys run locally through wrangler OAuth until the user sets those secrets.

## Phases
See `phase-*.md` files in this directory. Progress is tracked there.

## Provisioned Cloudflare resources (account 009dc0fcd0da3e503fbf38eb2b586e4b)
| Resource | staging | production |
|---|---|---|
| D1 | clarkcant-marketplace-db-staging `8e992426-e304-417f-ad62-631a3bedbdb2` | clarkcant-marketplace-db `243263e2-442e-4152-976f-0d0a7845eae7` |
| R2 | clarkcant-marketplace-media-staging | clarkcant-marketplace-media |
| Queue | clarkcant-marketplace-ingest-staging (+ `-dlq`) | clarkcant-marketplace-ingest (+ `-dlq`) |
| Workers | clarkcant-marketplace-web-staging, clarkcant-marketplace-jobs-staging | clarkcant-marketplace-web, clarkcant-marketplace-jobs |

## Research inputs
- plans/reports/researcher-260929-1909-cloudflare-stack-integration.md (versions, pins, snippets)
- plans/reports/scout-260929-1914-clarkcant-ecosystem-facts.md (manifest schema, brand, conventions)

## Phases and waves
| Wave | Phase | Owner scope | Depends |
|---|---|---|---|
| 1 | [phase-01-foundation](phase-01-foundation.md) | monorepo, contracts, db schema+migrations, app services skeleton, API skeleton, Astro app shell, wrangler, CI | — |
| 2 | [phase-02-page-engine-builder](phase-02-page-engine-builder.md) | page-engine, page services, pages API, admin builder, page routes | 1 |
| 2 | [phase-03-package-indexing](phase-03-package-indexing.md) | npm indexing, jobs worker, media, package/search services + routes + web pages | 1 |
| 2 | [phase-04-auth-accounts](phase-04-auth-accounts.md) | Better Auth, publishers, API tokens, device/OAuth, account + data lifecycle | 1 |
| 3 | [phase-05-agent-interfaces](phase-05-agent-interfaces.md) | OpenAPI completion, SDK, CLI, MCP, WebMCP | 2,3,4 |
| 3 | [phase-06-seo-hardening-legal](phase-06-seo-hardening-legal.md) | Markdown twins, sitemaps, llms, JSON-LD, share UX, OG, security headers, rate limit, legal, docs | 2,3,4 |
| 4 | phase-07 release (controller) | code review, UX/AX, staging+prod deploy, live verification | 5,6 |

## Decisions during execution
- A10 Indexed packages start as `listed` = "passed automated checks (manifest, integrity), not human-reviewed"; `featured`
  is the curated signal; `hidden`/`rejected` are removed from public surfaces. UI + docs must state this plainly.
- A11 Migration 0004 is Better Auth `rate_limit` (auth rate limiting stored in D1; no wrangler rate-limit binding used).
- A12 Curation is exposed via API/MCP only in this bootstrap (no dedicated curation admin UI).
