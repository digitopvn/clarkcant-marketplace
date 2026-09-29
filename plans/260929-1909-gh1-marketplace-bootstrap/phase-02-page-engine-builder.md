# Phase 02 — Page engine + admin builder (M1)

Status: completed (2026-09-29) · Wave 2 (parallel with 03, 04) · Depends on 01.

## Owns (only these files)
- `packages/page-engine/**` (new): block registry, blocks, layouts, HTML + Markdown renderers,
  structured-data + semantic-summary hooks, PageDocument validation, patch operations.
- `packages/marketplace/src/pages/**` (page commands/queries) + their tests.
- `packages/api/src/routes/pages.ts` and `packages/api/src/routes/admin.ts` (page/content admin ops).
- `apps/web/src/pages/[...slug].astro` (custom/editorial/legal/docs pages from PageDocument),
  `apps/web/src/pages/admin/**`, `apps/web/src/components/admin/**` (React islands), `apps/web/src/pages/preview/**`.
- `migrations/seed-pages-*.sql` only if a seed is needed (coordinate: no schema changes; report if the schema from phase 01 is insufficient).

## Requirements
- Contract (from issue): `PageDocument { schemaVersion:1, layout:{id,version}, blocks: BlockNode[], seo: PageSeo }`,
  `BlockNode { id, type, version, props, children? }`. Never persist HTML/JSX.
- `BlockDefinition { id, version, propsSchema (Zod → JSON Schema), allowedChildren?, renderWeb(ctx) → escaped HTML string,
  renderMarkdown(ctx) → string, getStructuredData(ctx) → object[], getSemanticSummary(ctx) → string,
  editor { label, icon?, fields: EditorField[] } }`. Block render context can resolve package/collection data through
  an injected read port (package grid, featured packages, collection, publisher profile blocks use real data).
- Blocks: hero, rich-text (Markdown, sanitized, no raw HTML), media (R2 media id), package-grid, featured-packages,
  collection, stats, cta, faq, comparison, logo-cloud, code-install-snippet, publisher-profile.
- Layouts: marketplace-landing, package-detail, category, collection, editorial, docs-legal (allowed block types + regions).
- Renderers: one renderWeb path used by the public route AND the builder canvas preview (no duplicate renderer);
  Markdown renderer from the AST (never scrape HTML).
- Revisions: editing creates/updates a draft revision (new immutable `page_revisions` row per save, parent link);
  publish is a separate command requiring `pages:publish`; rollback = publish an earlier revision (writes
  `page_publications` action=rollback). Optimistic concurrency via `expectedRevisionId` / `If-Match`.
  Every mutation: schema validation, scope check (scopes come from an `Actor` passed by caller — phase 04 wires
  real auth; until then API admin routes require the actor from `c.get('actor')`, which phase 04 populates),
  Idempotency-Key via the phase 01 idempotency store, audit event.
- Commands (shared by API/MCP/WebMCP): get_page, create_page, create_page_draft, add_block, update_block, remove_block,
  move_block, set_page_seo, preview_page, publish_page, rollback_page, list_page_revisions. Also a JSON-Patch-like
  `patch_page(ops[])` built from those primitives.
- API: `GET /api/v1/pages/:slug` (published only, JSON + optional `?format=md`); admin routes under
  `/api/v1/admin/pages/*` for all commands; preview tokens: `POST .../preview` returns a signed short-lived URL
  `/preview/<token>` rendering the draft (noindex).
- Admin builder UI at `/admin/pages` (list) and `/admin/pages/:id` (three-pane: block palette | canvas iframe using
  the same renderWeb | inspector with fields generated from `editor.fields`, SEO panel). Preview modes: Desktop,
  Tablet, Mobile, Markdown, Agent view (semantic summary + JSON-LD + PageDocument JSON), SEO preview (title/desc/
  canonical snippet), Social preview (OG card). Add/move/remove/update blocks, save draft, publish, rollback from
  revision list. Keyboard accessible, touch friendly, works at 375px (panes collapse to tabs).
- Seed: publish initial pages via a script/command using the services (not raw SQL HTML): marketplace landing (`/`
  may keep phase 01 home but should render from the landing PageDocument if present), plus editorial `about`.
  Legal pages are owned by phase 06 but will use this engine.
- Load guidance: C:\Users\admin\.claude\skills\ak-page-builder\references\{block-contract,page-operations,editor-ux,preview-publishing}.md

## Acceptance
- Unit tests: every block validates props and renders HTML + Markdown; invalid documents rejected; revision/
  publish/rollback/concurrency/idempotency behaviours; audit events written.
- Playwright: admin creates a custom page from blocks, previews, publishes; public `/<slug>` shows it; rollback works.
  (Admin auth: use phase 04 session once available; until then the test may use a seeded admin API token through
  the documented dev path — coordinate in report.)
- `pnpm verify && pnpm build` green.
